// ====================================================================
// GET /api/files/public/[...path]
// Serves a public asset (course thumbnail, logo, etc.) from local
// fallback storage. MinIO public assets are served directly via
// MINIO_PUBLIC_URL and never hit this route.
//
// Path traversal is blocked. Only public/ prefixed keys are allowed.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { isSafePath, detectMime, safeLocalPath } from "@/lib/services/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: parts } = await params;
  const objectKey = parts.map(decodeURIComponent).join("/");

  if (!isSafePath(objectKey)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Public prefixes only
  const isPublic =
    objectKey.startsWith("public/") ||
    objectKey.startsWith("courses/thumbnails/") ||
    objectKey.startsWith("courses/preview/");
  if (!isPublic) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const localPath = safeLocalPath(objectKey);
  if (!localPath) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  let buffer: Buffer;
  try {
    buffer = await fs.readFile(localPath);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  const mime = detectMime(buffer) || "application/octet-stream";

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": mime,
      "Content-Length": String(buffer.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
