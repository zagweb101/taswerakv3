// ====================================================================
// GET /api/files/public/[...path]
// Serves a public asset (course thumbnail, logo, etc.) from MinIO OR
// local storage, depending on the configured provider.
//
// Path traversal is blocked. Only public/ prefixed keys are allowed.
// The MinIO bucket stays PRIVATE — files are read via the MinIO API
// (signed internally) and streamed through this route, never exposed
// directly via a public MinIO URL.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { readPublicSecure, StorageError } from "@/lib/services/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: parts } = await params;
  const objectKey = parts.map(decodeURIComponent).join("/");

  // Public prefixes only — readPublicSecure also enforces this, but
  // we check here too so we can return 403 before touching storage.
  const isPublic =
    objectKey.startsWith("public/") ||
    objectKey.startsWith("courses/thumbnails/") ||
    objectKey.startsWith("courses/preview/");
  if (!isPublic) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  try {
    const result = await readPublicSecure(objectKey);
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": result.mime,
        "Content-Length": String(result.size),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    if (err instanceof StorageError) {
      if (err.code === "NOT_FOUND") return new NextResponse("Not found", { status: 404 });
      if (err.code === "PATH_UNSAFE" || err.code === "NOT_PUBLIC") {
        return new NextResponse("Forbidden", { status: 403 });
      }
      if (err.code === "MINIO_READ_FAILED") {
        return new NextResponse("Storage unavailable", { status: 503 });
      }
    }
    console.error("[files/public] error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
