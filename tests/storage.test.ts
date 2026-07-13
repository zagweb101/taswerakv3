// ====================================================================
// Storage layer tests — pure unit tests (no DB, no MinIO).
// ====================================================================

import { describe, it, expect } from "vitest";
import {
  isSafePath,
  safeLocalPath,
  detectMime,
  isMimeAllowed,
  makeSecureObjectKey,
  isAllowedFolder,
  PUBLIC_FOLDERS,
  PRIVATE_FOLDERS,
  StorageError,
} from "@/lib/services/storage";

describe("storage: path traversal guard", () => {
  it("rejects paths containing ..", () => {
    expect(isSafePath("../etc/passwd")).toBe(false);
    expect(isSafePath("foo/../bar")).toBe(false);
    expect(isSafePath("foo/..")).toBe(false);
  });

  it("rejects paths starting with /", () => {
    expect(isSafePath("/etc/passwd")).toBe(false);
    expect(isSafePath("/foo/bar")).toBe(false);
  });

  it("rejects paths containing null bytes", () => {
    expect(isSafePath("foo\0bar")).toBe(false);
  });

  it("rejects paths containing backslashes", () => {
    expect(isSafePath("foo\\bar")).toBe(false);
  });

  it("rejects empty path components", () => {
    expect(isSafePath("foo//bar")).toBe(false);
    expect(isSafePath("foo/")).toBe(false);
    expect(isSafePath("/foo")).toBe(false);
  });

  it("accepts well-formed relative paths", () => {
    expect(isSafePath("public/foo.jpg")).toBe(true);
    expect(isSafePath("private/receipts/2026/01/abc.jpg")).toBe(true);
    expect(isSafePath("foo")).toBe(true);
  });
});

describe("storage: safeLocalPath", () => {
  it("rejects traversal attempts", () => {
    expect(safeLocalPath("../etc/passwd")).toBeNull();
    expect(safeLocalPath("foo/../../etc/passwd")).toBeNull();
  });

  it("resolves valid keys under the local storage root", () => {
    const p = safeLocalPath("public/foo.jpg");
    expect(p).toBeTruthy();
    expect(p!).toContain(".upload");
  });
});

describe("storage: MIME detection (magic bytes)", () => {
  it("detects JPEG", () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    expect(detectMime(buf)).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    const buf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    expect(detectMime(buf)).toBe("image/png");
  });

  it("detects WebP", () => {
    const buf = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
    ]);
    expect(detectMime(buf)).toBe("image/webp");
  });

  it("detects PDF", () => {
    const buf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]);
    expect(detectMime(buf)).toBe("application/pdf");
  });

  it("detects MP4 (ftyp box)", () => {
    const buf = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    expect(detectMime(buf)).toBe("video/mp4");
  });

  it("returns null for random bytes that match no rule", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    expect(detectMime(buf)).toBeNull();
  });

  it("returns null for too-short buffers", () => {
    expect(detectMime(Buffer.from([0xff]))).toBeNull();
    expect(detectMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("storage: MIME spoofing detection", () => {
  it("rejects a buffer declared as JPEG but actually PNG", () => {
    const pngBuf = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const realMime = detectMime(pngBuf);
    expect(realMime).toBe("image/png");
    expect(realMime).not.toBe("image/jpeg");
  });

  it("rejects a buffer with a .jpg extension but EXE content", () => {
    // MZ header (Windows executable)
    const exeBuf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(detectMime(exeBuf)).toBeNull();
  });
});

describe("storage: MIME allowlist", () => {
  it("allows JPEG/PNG/WebP for private", () => {
    expect(isMimeAllowed("image/jpeg", "private")).toBe(true);
    expect(isMimeAllowed("image/png", "private")).toBe(true);
    expect(isMimeAllowed("image/webp", "private")).toBe(true);
  });

  it("allows PDF for private", () => {
    expect(isMimeAllowed("application/pdf", "private")).toBe(true);
  });

  it("rejects script mimetypes for private", () => {
    expect(isMimeAllowed("application/javascript", "private")).toBe(false);
    expect(isMimeAllowed("text/html", "private")).toBe(false);
    expect(isMimeAllowed("application/x-msdownload", "private")).toBe(false);
  });

  it("allows video/mp4 for public", () => {
    expect(isMimeAllowed("video/mp4", "public")).toBe(true);
  });
});

describe("storage: folder whitelist", () => {
  it("accepts whitelisted public folders", () => {
    expect(isAllowedFolder("public", "public")).toBe(true);
    expect(isAllowedFolder("public/foo", "public")).toBe(true);
    expect(isAllowedFolder("courses/thumbnails", "public")).toBe(true);
  });

  it("rejects non-whitelisted public folders", () => {
    expect(isAllowedFolder("evil", "public")).toBe(false);
    expect(isAllowedFolder("receipts", "public")).toBe(false);
  });

  it("accepts whitelisted private folders", () => {
    expect(isAllowedFolder("private/receipts", "private")).toBe(true);
    expect(isAllowedFolder("private/submissions", "private")).toBe(true);
    expect(isAllowedFolder("private/receipts/2026/01", "private")).toBe(true);
  });

  it("rejects public as private", () => {
    expect(isAllowedFolder("public", "private")).toBe(false);
  });

  it("PUBLIC_FOLDERS and PRIVATE_FOLDERS are disjoint", () => {
    for (const p of PUBLIC_FOLDERS) {
      expect(PRIVATE_FOLDERS.includes(p as any)).toBe(false);
    }
  });
});

describe("storage: unguessable object key", () => {
  it("hides original filename for private files", () => {
    const key = makeSecureObjectKey(
      "private/receipts",
      "my-secret-receipt-2026.jpg",
      "private"
    );
    expect(key).not.toContain("my-secret-receipt");
    expect(key).toMatch(/^private\/receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.jpg$/);
  });

  it("preserves original filename for public files", () => {
    const key = makeSecureObjectKey(
      "public",
      "thumbnail.png",
      "public"
    );
    expect(key).toContain("thumbnail.png");
    expect(key).toMatch(/^public\/\d{4}\/\d{2}\/[0-9a-f-]{36}_thumbnail\.png$/);
  });
});

describe("storage: StorageError", () => {
  it("exposes a code field", () => {
    const e = new StorageError("FOO", "bar");
    expect(e.code).toBe("FOO");
    expect(e.message).toBe("bar");
    expect(e.name).toBe("StorageError");
    expect(e instanceof Error).toBe(true);
  });
});
