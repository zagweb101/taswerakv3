// ====================================================================
// GET /api/files/private/[...path]
// Serves a private file (payment receipt or student submission).
//
// Authorization rules:
//   - Student can read only files that belong to them.
//   - Instructor can read files of students enrolled in their courses.
//   - Admin can read any file.
//   - Anonymous requests are rejected with 401.
//
// The path is matched against the database:
//   private/receipts/<yyyy>/<mm>/<uuid>.<ext>   →  PaymentReceipt.imageUrl
//   private/submissions/<yyyy>/<mm>/<uuid>.<ext> →  Submission.imageUrl
//
// Path traversal is blocked by the storage layer (safeLocalPath + isSafePath).
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { readSecure, StorageError, isSafePath } from "@/lib/services/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function findReceiptByObjectKey(objectKey: string) {
  const match = `/api/files/private/${objectKey}`;
  const receipt = await db.paymentReceipt.findFirst({
    where: { OR: [{ imageUrl: match }, { imageUrl: objectKey }] },
    select: {
      id: true,
      studentId: true,
      enrollment: {
        select: {
          course: { select: { instructorId: true } },
        },
      },
    },
  });
  return receipt;
}

async function findSubmissionByObjectKey(objectKey: string) {
  const match = `/api/files/private/${objectKey}`;
  const submission = await db.submission.findFirst({
    where: { OR: [{ imageUrl: match }, { imageUrl: objectKey }] },
    select: {
      id: true,
      studentId: true,
      assignment: {
        select: {
          course: { select: { instructorId: true } },
        },
      },
    },
  });
  return submission;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  // 1. Auth required
  const session = await auth();
  if (!session?.user?.id) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 2. Reconstruct and validate object key
  const { path: parts } = await params;
  const objectKey = parts.map(decodeURIComponent).join("/");
  if (!isSafePath(objectKey)) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // Only allow private prefixes
  if (
    !objectKey.startsWith("private/receipts/") &&
    !objectKey.startsWith("private/submissions/")
  ) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  // 3. Authorization — look up the owning record
  let ownerStudentId: string | null = null;
  let ownerInstructorId: string | null = null;

  if (objectKey.startsWith("private/receipts/")) {
    const r = await findReceiptByObjectKey(objectKey);
    if (!r) return new NextResponse("Not found", { status: 404 });
    ownerStudentId = r.studentId;
    ownerInstructorId = r.enrollment?.course.instructorId ?? null;
  } else {
    const s = await findSubmissionByObjectKey(objectKey);
    if (!s) return new NextResponse("Not found", { status: 404 });
    ownerStudentId = s.studentId;
    ownerInstructorId = s.assignment.course.instructorId ?? null;
  }

  if (!ownerStudentId) {
    return new NextResponse("Not found", { status: 404 });
  }

  const role = session.user.role;
  const userId = session.user.id;

  if (role === "ADMIN") {
    // Admin — allowed
  } else if (role === "INSTRUCTOR") {
    if (ownerInstructorId !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  } else {
    // STUDENT (or any other role) — only own files
    if (ownerStudentId !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }
  }

  // 4. Stream the file
  try {
    const result = await readSecure(objectKey);
    return new NextResponse(new Uint8Array(result.buffer), {
      status: 200,
      headers: {
        "Content-Type": result.mime,
        "Content-Length": String(result.size),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  } catch (err) {
    if (err instanceof StorageError) {
      if (err.code === "NOT_FOUND") return new NextResponse("Not found", { status: 404 });
      if (err.code === "PATH_UNSAFE" || err.code === "NOT_PRIVATE") {
        return new NextResponse("Forbidden", { status: 403 });
      }
    }
    console.error("[files/private] error:", err);
    return new NextResponse("Internal Server Error", { status: 500 });
  }
}
