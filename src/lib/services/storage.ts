// ====================================================================
// Taswerak — Secure storage layer
//
// Goals:
//  - Separate public assets (course thumbnails, logos) from private
//    assets (payment receipts, student submissions).
//  - Never expose private assets by raw URL.
//  - Use unguessable object keys (crypto.randomUUID) for private files.
//  - Prevent path traversal on local storage.
//  - Detect real MIME via magic bytes (not file.type which is spoofable).
//  - Make MinIO bucket PRIVATE by default; public prefix is opt-in.
//
// Public folder whitelist:   public/**, courses/thumbnails/**
// Private folder whitelist:  private/receipts/**, private/submissions/**
// ====================================================================

import { Client } from "minio";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";

// ---------- Configuration ----------
const endpoint = process.env.MINIO_ENDPOINT || "http://localhost:9000";
const port = parseInt(process.env.MINIO_PORT || "9000", 10);
const useSSL = process.env.MINIO_USE_SSL === "true";
const accessKey = process.env.MINIO_ACCESS_KEY || "";
const secretKey = process.env.MINIO_SECRET_KEY || "";
const bucket = process.env.MINIO_BUCKET || "taswerak-uploads";
const publicUrl = process.env.MINIO_PUBLIC_URL || endpoint;
const localStorageDir =
  process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), ".upload");

// STORAGE_PROVIDER=auto means: use minio if creds present, else local
const STORAGE_PROVIDER = (
  process.env.STORAGE_PROVIDER || "auto"
).toLowerCase();

// ---------- Public/Private folder whitelist ----------
export const PUBLIC_FOLDERS = ["public", "courses/thumbnails", "courses/preview"] as const;
export const PRIVATE_FOLDERS = [
  "private/receipts",
  "private/submissions",
] as const;

export type StorageVisibility = "public" | "private";

export function isAllowedFolder(folder: string, visibility: StorageVisibility): boolean {
  if (visibility === "public") {
    return PUBLIC_FOLDERS.some((f) => folder === f || folder.startsWith(f + "/"));
  }
  return PRIVATE_FOLDERS.some((f) => folder === f || folder.startsWith(f + "/"));
}

// ---------- Path traversal guard ----------
/**
 * Reject any path component that:
 *  - contains ".."
 *  - contains "\0"
 *  - starts with "/"
 *  - contains backslashes
 *  - is empty
 */
export function isSafePath(p: string): boolean {
  if (!p || typeof p !== "string") return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/")) return false;
  if (p.includes("\\")) return false;
  const parts = p.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return false;
  }
  return true;
}

/**
 * Convert an object key into a local filesystem path under localStorageDir,
 * rejecting traversal attempts. Returns null if the key is unsafe.
 */
export function safeLocalPath(objectKey: string): string | null {
  if (!isSafePath(objectKey)) return null;
  // Normalize and resolve, then verify it stays inside localStorageDir
  const root = path.resolve(localStorageDir);
  const resolved = path.resolve(root, objectKey);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }
  return resolved;
}

// ---------- Real MIME detection (magic bytes) ----------
interface MagicRule {
  type: string;
  offset: number;
  bytes: number[];
}

// Minimal magic-byte table — covers the file types Taswerak accepts.
const MAGIC_RULES: MagicRule[] = [
  // JPEG
  { type: "image/jpeg", offset: 0, bytes: [0xff, 0xd8, 0xff] },
  // PNG
  { type: "image/png", offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // WebP — "RIFF"...."WEBP"
  { type: "image/webp", offset: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  // GIF87a / GIF89a
  { type: "image/gif", offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  // PDF
  { type: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  // MP4 — ftyp box at offset 4
  { type: "video/mp4", offset: 4, bytes: [0x66, 0x74, 0x79, 0x70] },
];

/**
 * Detect the real MIME type of a buffer by its magic bytes.
 * Returns null if the buffer matches no known type.
 *
 * Minimum buffer size accepted: 4 bytes (the smallest magic rule).
 */
export function detectMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 4) return null;
  for (const rule of MAGIC_RULES) {
    if (buffer.length < rule.offset + rule.bytes.length) continue;
    const slice = buffer.slice(rule.offset, rule.offset + rule.bytes.length);
    let match = true;
    for (let i = 0; i < rule.bytes.length; i++) {
      if (slice[i] !== rule.bytes[i]) {
        match = false;
        break;
      }
    }
    if (match) {
      // Special-case WebP: RIFF + WEBP at offset 8
      if (rule.type === "image/webp") {
        if (buffer.length < 12) continue;
        const tag = buffer.slice(8, 12).toString("ascii");
        if (tag !== "WEBP") continue;
      }
      return rule.type;
    }
  }
  return null;
}

// ---------- File type policy ----------
export const ALLOWED_PUBLIC_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "video/mp4",
];

export const ALLOWED_PRIVATE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
];

export function isMimeAllowed(mime: string, visibility: StorageVisibility): boolean {
  const list = visibility === "public" ? ALLOWED_PUBLIC_MIMES : ALLOWED_PRIVATE_MIMES;
  return list.includes(mime);
}

// ---------- Size limits ----------
export const MAX_PUBLIC_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (videos)
export const MAX_PRIVATE_RECEIPT_SIZE = 5 * 1024 * 1024; // 5 MB
export const MAX_PRIVATE_SUBMISSION_SIZE = 10 * 1024 * 1024; // 10 MB

export function getMaxSizeForFolder(folder: string): number {
  if (folder.startsWith("private/receipts")) return MAX_PRIVATE_RECEIPT_SIZE;
  if (folder.startsWith("private/submissions")) return MAX_PRIVATE_SUBMISSION_SIZE;
  return MAX_PUBLIC_FILE_SIZE;
}

// ---------- Object key generation ----------
/**
 * Generate an unguessable object key.
 * Pattern: {folder}/{yyyy}/{mm}/{uuid}_{safeOriginalName}
 *
 * For private folders we strip the original filename entirely and use only
 * a UUID — so the only way to fetch the file is via the database row that
 * records who owns it.
 */
export function makeSecureObjectKey(
  folder: string,
  originalFilename: string,
  visibility: StorageVisibility = "private"
): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const uuid = crypto.randomUUID();
  const safeName = (originalFilename || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 60);
  if (visibility === "private") {
    // Hide original filename — use UUID only
    const ext = path.extname(safeName).toLowerCase() || ".bin";
    return `${folder}/${yyyy}/${mm}/${uuid}${ext}`;
  }
  return `${folder}/${yyyy}/${mm}/${uuid}_${safeName || "file"}`;
}

// ---------- MinIO client (lazy) ----------
let client: Client | null = null;
let clientInitFailed = false;

function getMinioClient(): Client | null {
  if (clientInitFailed) return null;
  if (client) return client;
  if (!accessKey || !secretKey) {
    clientInitFailed = true;
    return null;
  }
  try {
    client = new Client({
      endPoint: endpoint.replace(/^https?:\/\//, ""),
      port,
      useSSL,
      accessKey,
      secretKey,
    });
    return client;
  } catch (err) {
    console.warn("[storage] minio init failed:", err);
    clientInitFailed = true;
    return null;
  }
}

/**
 * Determine the effective storage provider.
 *
 * - "minio": STORAGE_PROVIDER=minio → MUST use MinIO. If MinIO is
 *   unreachable, uploads FAIL (no local fallback). This is the
 *   production-safe mode — data must go to MinIO or nowhere.
 *
 * - "local": STORAGE_PROVIDER=local → always use the local filesystem.
 *
 * - "auto" (default): STORAGE_PROVIDER=auto → use MinIO if credentials
 *   are present and the client initializes, else fall back to local
 *   WITH a console warning. Suitable for dev/staging.
 */
function usingMinio(): boolean {
  if (STORAGE_PROVIDER === "local") return false;
  if (STORAGE_PROVIDER === "minio") return true;
  // auto — fall back to local if MinIO creds are missing
  const c = getMinioClient();
  if (!c && STORAGE_PROVIDER === "auto") {
    // Only warn once per process
    if (!autoFallbackWarned) {
      console.warn(
        "[storage] STORAGE_PROVIDER=auto but MinIO credentials are missing — falling back to local storage. " +
          "Set STORAGE_PROVIDER=minio in production to fail-closed instead."
      );
      autoFallbackWarned = true;
    }
  }
  return !!c;
}

let autoFallbackWarned = false;

async function ensureBucketPrivate(): Promise<void> {
  const c = getMinioClient();
  if (!c) return;
  try {
    const exists = await c.bucketExists(bucket);
    if (!exists) {
      await c.makeBucket(bucket);
      // DO NOT set a public bucket policy — keep it private by default.
    }
  } catch (err) {
    console.warn("[storage] ensureBucket warning:", err);
  }
}

// ---------- Upload ----------
export interface UploadResult {
  /** Object key — the only stable identifier callers should store */
  objectKey: string;
  /** For public files: a directly-accessible URL. For private files: null. */
  publicUrl: string | null;
  /** Storage backend used */
  provider: "minio" | "local";
  /** Detected MIME (real, from magic bytes) */
  mime: string;
  /** File size in bytes */
  size: number;
}

export interface UploadOptions {
  visibility: StorageVisibility;
  folder: string;
  buffer: Buffer;
  originalFilename?: string;
  declaredMime?: string;
  maxSize?: number;
}

/**
 * Upload a file with full validation.
 * Throws typed errors on validation failure.
 */
export async function uploadSecure(opts: UploadOptions): Promise<UploadResult> {
  const { visibility, folder, buffer, originalFilename = "file", declaredMime } = opts;

  // 1. Folder whitelist
  if (!isAllowedFolder(folder, visibility)) {
    throw new StorageError(
      "FOLDER_NOT_ALLOWED",
      `Folder '${folder}' is not in the ${visibility} whitelist`
    );
  }

  // 2. Path safety on the folder itself
  if (!isSafePath(folder)) {
    throw new StorageError("FOLDER_UNSAFE", `Folder '${folder}' failed path safety check`);
  }

  // 3. Size limit
  const maxSize = opts.maxSize ?? getMaxSizeForFolder(folder);
  if (buffer.length > maxSize) {
    throw new StorageError(
      "FILE_TOO_LARGE",
      `File is ${buffer.length} bytes, max allowed is ${maxSize} bytes`
    );
  }

  // 4. Real MIME detection
  const realMime = detectMime(buffer);
  if (!realMime) {
    throw new StorageError(
      "MIME_UNKNOWN",
      "Could not detect file type from magic bytes"
    );
  }
  if (declaredMime && declaredMime !== realMime) {
    throw new StorageError(
      "MIME_SPOOFED",
      `Declared '${declaredMime}' but real type is '${realMime}'`
    );
  }
  if (!isMimeAllowed(realMime, visibility)) {
    throw new StorageError(
      "MIME_NOT_ALLOWED",
      `MIME '${realMime}' is not allowed for ${visibility} storage`
    );
  }

  // 5. Generate unguessable object key
  const objectKey = makeSecureObjectKey(folder, originalFilename, visibility);

  // 6. Persist
  //
  // Fail-closed policy:
  //   - STORAGE_PROVIDER=minio → MUST use MinIO. If MinIO fails, throw
  //     (no local fallback). The bucket stays PRIVATE.
  //   - STORAGE_PROVIDER=auto → try MinIO first; if it fails, fall back
  //     to local WITH a warning (already logged in usingMinio()).
  //   - STORAGE_PROVIDER=local → always local.
  //
  // Public URL policy:
  //   - For public files, ALWAYS return /api/files/public/{objectKey}
  //     (never a direct MinIO URL). This keeps the bucket private and
  //     routes all reads through our /api/files/public endpoint which
  //     can serve from either MinIO or local transparently.
  if (usingMinio()) {
    try {
      await ensureBucketPrivate();
      const c = getMinioClient()!;
      await c.putObject(bucket, objectKey, buffer, buffer.length, {
        "Content-Type": realMime,
        "x-amz-meta-visibility": visibility,
      });
      return {
        objectKey,
        publicUrl: visibility === "public" ? `/api/files/public/${objectKey}` : null,
        provider: "minio",
        mime: realMime,
        size: buffer.length,
      };
    } catch (err) {
      // If STORAGE_PROVIDER=minio, FAIL CLOSED — do not fall back to local.
      if (STORAGE_PROVIDER === "minio") {
        console.error("[storage] MinIO upload failed (fail-closed mode):", err);
        throw new StorageError(
          "MINIO_UPLOAD_FAILED",
          `MinIO upload failed and STORAGE_PROVIDER=minio — refusing to fall back to local. Error: ${(err as Error).message}`
        );
      }
      // auto mode — fall back to local with warning
      console.warn("[storage] MinIO upload failed, falling back to local (auto mode):", err);
    }
  }

  // Local storage (or auto fallback)
  const localPath = safeLocalPath(objectKey);
  if (!localPath) {
    throw new StorageError("PATH_UNSAFE", `Resolved object key is unsafe: ${objectKey}`);
  }
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, buffer);
  return {
    objectKey,
    publicUrl: visibility === "public" ? `/api/files/public/${objectKey}` : null,
    provider: "local",
    mime: realMime,
    size: buffer.length,
  };
}

// ---------- Read (for private file serving) ----------
export interface ReadResult {
  buffer: Buffer;
  mime: string;
  size: number;
  provider: "minio" | "local";
}

/**
 * Read a private file by its object key.
 * Caller is responsible for authorization — this function does NOT check.
 */
export async function readSecure(objectKey: string): Promise<ReadResult> {
  if (!isSafePath(objectKey)) {
    throw new StorageError("PATH_UNSAFE", `Object key is unsafe: ${objectKey}`);
  }
  // Private prefix is required
  const isPrivate = PRIVATE_FOLDERS.some(
    (f) => objectKey === f || objectKey.startsWith(f + "/")
  );
  if (!isPrivate) {
    throw new StorageError(
      "NOT_PRIVATE",
      `readSecure may only be called for private prefixes; got ${objectKey}`
    );
  }

  if (usingMinio()) {
    try {
      const c = getMinioClient()!;
      const stream = await c.getObject(bucket, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const buffer = Buffer.concat(chunks);
      const stat = await c.statObject(bucket, objectKey);
      return {
        buffer,
        mime: stat.metaData["content-type"] || "application/octet-stream",
        size: buffer.length,
        provider: "minio",
      };
    } catch (err) {
      // If STORAGE_PROVIDER=minio, FAIL CLOSED — do not fall back to local.
      if (STORAGE_PROVIDER === "minio") {
        throw new StorageError(
          "MINIO_READ_FAILED",
          `MinIO read failed and STORAGE_PROVIDER=minio — refusing to fall back to local. Error: ${(err as Error).message}`
        );
      }
      console.warn("[storage] MinIO read failed, falling back to local (auto mode):", err);
    }
  }

  const localPath = safeLocalPath(objectKey);
  if (!localPath) {
    throw new StorageError("PATH_UNSAFE", `Object key is unsafe: ${objectKey}`);
  }
  try {
    const buffer = await fs.readFile(localPath);
    return {
      buffer,
      mime: detectMime(buffer) || "application/octet-stream",
      size: buffer.length,
      provider: "local",
    };
  } catch {
    throw new StorageError("NOT_FOUND", `File not found: ${objectKey}`);
  }
}

// ---------- Read PUBLIC files (for /api/files/public/[...path]) ----------
/**
 * Read a public file by its object key.
 * Unlike readSecure, this accepts public-prefixed keys.
 * Reads from MinIO or local depending on the provider (fail-closed for minio).
 */
export async function readPublicSecure(objectKey: string): Promise<ReadResult> {
  if (!isSafePath(objectKey)) {
    throw new StorageError("PATH_UNSAFE", `Object key is unsafe: ${objectKey}`);
  }
  // Must be a public prefix
  const isPublic =
    objectKey.startsWith("public/") ||
    objectKey.startsWith("courses/thumbnails/") ||
    objectKey.startsWith("courses/preview/");
  if (!isPublic) {
    throw new StorageError(
      "NOT_PUBLIC",
      `readPublicSecure may only be called for public prefixes; got ${objectKey}`
    );
  }

  if (usingMinio()) {
    try {
      const c = getMinioClient()!;
      const stream = await c.getObject(bucket, objectKey);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const buffer = Buffer.concat(chunks);
      const stat = await c.statObject(bucket, objectKey);
      return {
        buffer,
        mime: stat.metaData["content-type"] || detectMime(buffer) || "application/octet-stream",
        size: buffer.length,
        provider: "minio",
      };
    } catch (err) {
      if (STORAGE_PROVIDER === "minio") {
        throw new StorageError(
          "MINIO_READ_FAILED",
          `MinIO read failed and STORAGE_PROVIDER=minio — refusing to fall back to local. Error: ${(err as Error).message}`
        );
      }
      console.warn("[storage] MinIO public read failed, falling back to local (auto mode):", err);
    }
  }

  const localPath = safeLocalPath(objectKey);
  if (!localPath) {
    throw new StorageError("PATH_UNSAFE", `Object key is unsafe: ${objectKey}`);
  }
  try {
    const buffer = await fs.readFile(localPath);
    return {
      buffer,
      mime: detectMime(buffer) || "application/octet-stream",
      size: buffer.length,
      provider: "local",
    };
  } catch {
    throw new StorageError("NOT_FOUND", `File not found: ${objectKey}`);
  }
}

// ---------- Delete (for cleanup on DB transaction failure) ----------
/**
 * Delete a file by its object key.
 * Tries MinIO first (removeObject), then local filesystem.
 * Used to clean up orphaned files when a DB transaction fails after
 * an upload has already written the file.
 *
 * Best-effort: logs errors but does NOT throw (so it can be used in
 * catch blocks without masking the original error).
 */
export async function deleteSecure(objectKey: string): Promise<void> {
  if (!isSafePath(objectKey)) {
    console.warn("[storage] deleteSecure: unsafe path, skipping:", objectKey);
    return;
  }

  if (usingMinio()) {
    try {
      const c = getMinioClient()!;
      await c.removeObject(bucket, objectKey);
      return;
    } catch (err) {
      // If MinIO delete fails, also try local (the file might have been
      // written there during an auto-mode fallback before the transaction
      // failed).
      console.warn("[storage] MinIO delete failed, trying local:", err);
    }
  }

  // Local delete (or auto-fallback cleanup)
  const localPath = safeLocalPath(objectKey);
  if (!localPath) {
    console.warn("[storage] deleteSecure: unsafe local path, skipping:", objectKey);
    return;
  }
  try {
    await fs.unlink(localPath);
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // File doesn't exist — that's fine for cleanup
      return;
    }
    console.warn("[storage] local delete failed:", err);
  }
}

// ---------- Typed error ----------
export class StorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "StorageError";
  }
}

// ---------- Public introspection ----------
export const storageStatus = {
  provider: usingMinio() ? "minio" : "local",
  storageProviderEnv: STORAGE_PROVIDER,
  bucket,
  publicUrl,
  localStorageDir,
};

/**
 * Check storage readiness for the /api/health/ready endpoint.
 *
 * - If STORAGE_PROVIDER=minio: pings MinIO and verifies the bucket
 *   exists. Returns down if MinIO is unreachable or the bucket is
 *   missing.
 * - If STORAGE_PROVIDER=local: verifies the local storage dir is
 *   writable.
 * - If STORAGE_PROVIDER=auto: if MinIO creds are present, pings MinIO
 *   (bucket existence); otherwise checks local dir writability.
 */
export async function checkStorageReadiness(): Promise<{
  ok: boolean;
  provider: string;
  error?: string;
}> {
  // Local mode — just check the dir is writable
  if (STORAGE_PROVIDER === "local") {
    try {
      await fs.mkdir(localStorageDir, { recursive: true });
      const probe = path.join(localStorageDir, ".ready-probe");
      await fs.writeFile(probe, "ok");
      await fs.unlink(probe);
      return { ok: true, provider: "local" };
    } catch (err: any) {
      return {
        ok: false,
        provider: "local",
        error: (err?.message || "Local storage dir not writable").slice(0, 120),
      };
    }
  }

  // minio or auto — ping MinIO and verify bucket exists
  const c = getMinioClient();
  if (!c) {
    if (STORAGE_PROVIDER === "minio") {
      return {
        ok: false,
        provider: "minio",
        error: "MinIO credentials missing (STORAGE_PROVIDER=minio requires MINIO_ACCESS_KEY + MINIO_SECRET_KEY)",
      };
    }
    // auto — fall back to local check
    return checkStorageReadinessLocal();
  }

  try {
    const exists = await c.bucketExists(bucket);
    if (!exists) {
      return {
        ok: false,
        provider: "minio",
        error: `Bucket '${bucket}' does not exist on MinIO`,
      };
    }
    return { ok: true, provider: "minio" };
  } catch (err: any) {
    return {
      ok: false,
      provider: "minio",
      error: (err?.message || "MinIO unreachable").slice(0, 120),
    };
  }
}

async function checkStorageReadinessLocal(): Promise<{
  ok: boolean;
  provider: string;
  error?: string;
}> {
  try {
    await fs.mkdir(localStorageDir, { recursive: true });
    const probe = path.join(localStorageDir, ".ready-probe");
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { ok: true, provider: "local" };
  } catch (err: any) {
    return {
      ok: false,
      provider: "local",
      error: (err?.message || "Local storage dir not writable").slice(0, 120),
    };
  }
}
