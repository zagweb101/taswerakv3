// ====================================================================
// GET /api/files/:filename  (LEGACY)
//
// This route existed before the production-readiness refactor and stored
// every uploaded file under a flat .upload/<filename> namespace. To stay
// backward compatible we still serve those flat files, but with two hard
// rules:
//
//   1. Path traversal is blocked (basename only, no "..", no leading "/").
//   2. Receipts / submissions / private files are NOT served here. Any
//      filename starting with "receipts_", "submissions_", "private_"
//      returns 403 — those files are only accessible through
//      /api/files/private/<objectKey> with authorization.
//
// New uploads never write to this flat namespace — they go through
// @/lib/services/storage which uses public/ or private/ prefixes.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { detectMime } from "@/lib/services/storage";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".mov": "video/quicktime",
};

// Files written by the old uploadFile() flattened slashes to underscores,
// so a receipt stored at "receipts/2026/01/abc_x.jpg" became
// "receipts_2026_01_abc_x.jpg" on disk. We block any such name.
const PRIVATE_PREFIXES = ["receipts_", "submissions_", "private_", "_emails"];

function isPrivateFlatName(name: string): boolean {
  return PRIVATE_PREFIXES.some((p) => name.startsWith(p));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  try {
    const { filename } = await params;

    // Block path traversal — only allow simple basenames
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || safeFilename.includes("..") || safeFilename.includes("/")) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    if (safeFilename.includes("\\")) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    // Block legacy private-file names
    if (isPrivateFlatName(safeFilename)) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    const filePath = path.join(process.cwd(), ".upload", safeFilename);

    let fileSize = 0;
    try {
      const stats = await fs.stat(filePath);
      fileSize = stats.size;
    } catch {
      return new NextResponse("File not found", { status: 404 });
    }

    const ext = path.extname(safeFilename).toLowerCase();
    const fallbackMime = MIME_TYPES[ext] || "application/octet-stream";

    const range = req.headers.get("range");
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize) {
        return new NextResponse("Requested Range Not Satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${fileSize}` },
        });
      }
      const chunksize = (end - start) + 1;
      const fileHandle = await fs.open(filePath, "r");
      const buffer = Buffer.alloc(chunksize);
      await fileHandle.read(buffer, 0, chunksize, start);
      await fileHandle.close();
      return new NextResponse(buffer, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${fileSize}`,
          "Accept-Ranges": "bytes",
          "Content-Length": String(chunksize),
          "Content-Type": fallbackMime,
          "Cache-Control": "public, max-age=31536000, immutable",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const buffer = await fs.readFile(filePath);
    // Use real MIME detection where possible — fallback to extension map.
    const realMime = detectMime(buffer) || fallbackMime;

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Length": String(fileSize),
        "Content-Type": realMime,
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[api/files/legacy] error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
