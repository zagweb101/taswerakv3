// ====================================================================
// Taswerak — Legacy storage shim
//
// IMPORTANT: This module is kept only for backward compatibility.
// New code MUST use @/lib/services/storage instead, which enforces:
//   - public/private folder separation
//   - real MIME detection (magic bytes)
//   - unguessable object keys for private files
//   - path traversal guards
//   - private MinIO bucket (no public policy)
//
// The old uploadFile() signature is preserved but internally delegates
// to uploadSecure() with visibility="public" for non-private folders.
// Calls targeting "receipts" or "submissions" are routed to "private"
// visibility to avoid exposing sensitive files publicly.
// ====================================================================

import {
  uploadSecure,
  makeSecureObjectKey,
  type UploadResult,
  type StorageVisibility,
} from "@/lib/services/storage";

/** Determine visibility from the legacy folder name. */
function visibilityFor(folder: string): StorageVisibility {
  if (folder.startsWith("receipts") || folder.startsWith("submissions")) {
    return "private";
  }
  return "public";
}

/** Map legacy folder name to the new public/private prefix. */
function remapFolder(folder: string, visibility: StorageVisibility): string {
  if (visibility === "private") {
    if (folder.startsWith("receipts")) return "private/receipts";
    if (folder.startsWith("submissions")) return "private/submissions";
  }
  // Public — keep under "public/" prefix to be safe
  if (
    folder.startsWith("public/") ||
    folder.startsWith("courses/thumbnails") ||
    folder.startsWith("courses/preview")
  ) {
    return folder;
  }
  return `public/${folder}`;
}

/**
 * @deprecated Use uploadSecure() from @/lib/services/storage.
 * Upload a buffer and return a URL/key.
 */
export async function uploadFile(
  buffer: Buffer,
  objectKey: string,
  contentType: string
): Promise<{ url: string; provider: "minio" | "local" }> {
  // The legacy API receives a fully-built objectKey like "receipts/2026/01/abc_file.jpg".
  // We split it back into folder + filename so the new validator can run.
  const slashIdx = objectKey.indexOf("/");
  const folder = slashIdx > 0 ? objectKey.slice(0, slashIdx) : objectKey;
  const visibility = visibilityFor(folder);
  const newFolder = remapFolder(folder, visibility);
  const filename = slashIdx > 0 ? objectKey.slice(slashIdx + 1) : objectKey;

  let result: UploadResult;
  try {
    result = await uploadSecure({
      visibility,
      folder: newFolder,
      buffer,
      originalFilename: filename,
      declaredMime: contentType,
    });
  } catch (err: any) {
    // Preserve the legacy contract: throw on real errors, but the legacy
    // uploadFile() callers checked `file.type` themselves before calling,
    // so a MIME mismatch here is a 400-class error.
    throw err;
  }

  // For private files the new API returns publicUrl=null; legacy callers
  // stored the URL in DB. To keep them working we return the objectKey
  // wrapped as a /api/files/private/... URL — the new protected route
  // will serve it.
  if (result.publicUrl) {
    return { url: result.publicUrl, provider: result.provider };
  }
  return {
    url: `/api/files/private/${result.objectKey}`,
    provider: result.provider,
  };
}

/** @deprecated Use makeSecureObjectKey() from @/lib/services/storage. */
export function makeObjectKey(folder: string, filename: string): string {
  const visibility = visibilityFor(folder);
  const newFolder = remapFolder(folder, visibility);
  return makeSecureObjectKey(newFolder, filename, visibility);
}

export { storageStatus } from "@/lib/services/storage";
