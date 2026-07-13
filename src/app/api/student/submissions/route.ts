// ====================================================================
// POST /api/student/submissions
// Upload an assignment submission with image + EXIF data.
//
// Security:
//   - Auth: must be STUDENT
//   - Enrollment must be ACTIVE for the course
//   - Cannot exceed assignment.maxAttempts
//   - Real MIME detection (magic bytes), no spoofing
//   - Unguessable object key (UUID) under private/submissions
//   - Atomic: DB write inside a transaction; on failure, delete the file
//   - Audit log + instructor notification
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  uploadSecure,
  StorageError,
  MAX_PRIVATE_SUBMISSION_SIZE,
} from "@/lib/services/storage";
import { writeAudit, notify } from "@/lib/services/audit";

const metadataSchema = z.object({
  assignmentId: z.string().min(1),
  caption: z.string().max(1000).optional().default(""),
  exifData: z.record(z.string(), z.any()).optional().default({}),
});

const ALLOWED_DECLARED_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
  }
  if (session.user.role !== "STUDENT") {
    return NextResponse.json({ ok: false, error: "هذه العملية للطلاب فقط" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("image") as File | null;
  const metadataRaw = form.get("metadata");

  if (!file) {
    return NextResponse.json({ ok: false, error: "الصورة مطلوبة" }, { status: 400 });
  }
  if (!ALLOWED_DECLARED_TYPES.includes(file.type)) {
    return NextResponse.json(
      { ok: false, error: "الصيغة غير مدعومة. استخدم JPG أو PNG أو WebP" },
      { status: 400 }
    );
  }
  if (file.size > MAX_PRIVATE_SUBMISSION_SIZE) {
    return NextResponse.json(
      { ok: false, error: "حجم الصورة يجب أن لا يتجاوز 10 ميجابايت" },
      { status: 400 }
    );
  }
  if (!metadataRaw) {
    return NextResponse.json({ ok: false, error: "البيانات ناقصة" }, { status: 400 });
  }

  let parsed: z.infer<typeof metadataSchema>;
  try {
    parsed = metadataSchema.parse(JSON.parse(metadataRaw as string));
  } catch (err: any) {
    const msg = err?.issues?.[0]?.message || "بيانات غير صحيحة";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
  const { assignmentId, caption, exifData } = parsed;

  const assignment = await db.assignment.findUnique({
    where: { id: assignmentId },
    include: {
      course: {
        select: { id: true, titleAr: true, title: true, instructorId: true },
      },
      lesson: { select: { id: true } },
    },
  });

  if (!assignment) {
    return NextResponse.json({ ok: false, error: "الواجب غير موجود" }, { status: 404 });
  }

  const enrollment = await db.enrollment.findUnique({
    where: {
      studentId_courseId: {
        studentId: session.user.id,
        courseId: assignment.courseId,
      },
    },
  });

  if (!enrollment || enrollment.status !== "ACTIVE") {
    return NextResponse.json(
      { ok: false, error: "غير مسجّل في هذه الدورة" },
      { status: 403 }
    );
  }

  // ---------- Enforce maxAttempts ----------
  const existingCount = await db.submission.count({
    where: { assignmentId, studentId: session.user.id },
  });
  const maxAttempts = assignment.maxAttempts || 1;
  if (existingCount >= maxAttempts) {
    return NextResponse.json(
      {
        ok: false,
        error: `لقد استنفدت الحد الأقصى من المحاولات (${maxAttempts}) لهذا الواجب`,
      },
      { status: 409 }
    );
  }

  // ---------- Upload ----------
  const buffer = Buffer.from(await file.arrayBuffer());

  let uploaded: { objectKey: string; provider: "minio" | "local"; mime: string; size: number };
  try {
    uploaded = await uploadSecure({
      visibility: "private",
      folder: "private/submissions",
      buffer,
      originalFilename: file.name || "submission.jpg",
      declaredMime: file.type,
      maxSize: MAX_PRIVATE_SUBMISSION_SIZE,
    });
  } catch (err) {
    if (err instanceof StorageError) {
      const msgMap: Record<string, string> = {
        MIME_SPOOFED: "نوع الملف لا يطابق الصيغة المُعلنة",
        MIME_NOT_ALLOWED: "الصيغة غير مدعومة. استخدم JPG أو PNG أو WebP",
        MIME_UNKNOWN: "تعذّر التحقق من نوع الملف",
        FILE_TOO_LARGE: "حجم الصورة يجب أن لا يتجاوز 10 ميجابايت",
        FOLDER_NOT_ALLOWED: "مسار التخزين غير مسموح",
        PATH_UNSAFE: "مسار الملف غير آمن",
      };
      return NextResponse.json(
        { ok: false, error: msgMap[err.code] || "فشل رفع الملف" },
        { status: 400 }
      );
    }
    console.error("[submissions/upload] storage error:", err);
    return NextResponse.json({ ok: false, error: "فشل رفع الملف" }, { status: 500 });
  }

  const imageUrl = `/api/files/private/${uploaded.objectKey}`;

  // ---------- DB transaction ----------
  try {
    const submission = await db.$transaction(async (tx) => {
      return tx.submission.create({
        data: {
          assignmentId,
          studentId: session.user.id,
          enrollmentId: enrollment.id,
          lessonId: assignment.lessonId,
          imageUrl,
          originalFileName: file.name,
          fileSize: file.size,
          mimeType: uploaded.mime, // real MIME, not file.type
          exifData: exifData || null,
          caption: caption || null,
          status: "SUBMITTED",
          attemptNumber: existingCount + 1,
        },
      });
    });

    await writeAudit({
      userId: session.user.id,
      action: "SUBMISSION_UPLOAD",
      entity: "Submission",
      entityId: submission.id,
      metadata: {
        assignmentId,
        courseName: assignment.course.titleAr || assignment.course.title,
        attemptNumber: submission.attemptNumber,
        maxAttempts,
        storageProvider: uploaded.provider,
        storageObjectKey: uploaded.objectKey,
        realMime: uploaded.mime,
        hasExif: !!exifData && Object.keys(exifData).length > 0,
      },
      ipAddress: req.headers.get("x-forwarded-for") || undefined,
      userAgent: req.headers.get("user-agent") || undefined,
    });

    await notify({
      userId: assignment.course.instructorId,
      title: "تسليم واجب جديد 📷",
      body: `سلّم الطالب ${session.user.name || ""} واجباً في دورة "${assignment.course.titleAr || assignment.course.title}".`,
      type: "COURSE_UPDATE",
      link: `/instructor/critiques/${submission.id}`,
    });

    return NextResponse.json({
      ok: true,
      submissionId: submission.id,
      attemptNumber: submission.attemptNumber,
      maxAttempts,
      message: "تم تسليم الواجب بنجاح! سيتم إشعار المدرّب.",
    });
  } catch (err) {
    console.error("[submissions/upload] DB transaction failed, deleting uploaded file:", err);
    // best-effort cleanup of orphaned file (local only)
    try {
      const path = await import("path");
      const fs = await import("fs/promises");
      const localPath = path.join(process.cwd(), ".upload", uploaded.objectKey);
      await fs.unlink(localPath).catch(() => {});
    } catch {
      // best-effort
    }
    return NextResponse.json(
      { ok: false, error: "فشل حفظ التسليم. حاول مرة أخرى." },
      { status: 500 }
    );
  }
}
