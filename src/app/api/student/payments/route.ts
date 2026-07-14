// ====================================================================
// POST /api/student/payments
// Upload a manual bank transfer receipt end-to-end:
//   1. Validate auth (must be STUDENT)
//   2. Parse multipart form (image + metadata)
//   3. Validate image type/size AND real MIME (magic bytes)
//   4. Verify course exists + is PUBLISHED
//   5. Validate amount is a positive finite number
//   6. Prevent duplicate enrollment (ACTIVE / PENDING_APPROVAL)
//   7. Upload to private/receipts via secure storage
//   8. In a single transaction: create Enrollment + PaymentReceipt
//   9. If DB write fails, delete the uploaded file (no orphans)
//  10. Write audit log
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import {
  uploadSecure,
  deleteSecure,
  StorageError,
  MAX_PRIVATE_RECEIPT_SIZE,
} from "@/lib/services/storage";
import { writeAudit } from "@/lib/services/audit";
import { z } from "zod";

const metadataSchema = z.object({
  courseId: z.string().min(1, "الدورة مطلوبة"),
  bankName: z.string().min(2, "اسم البنك مطلوب"),
  amount: z
    .string()
    .or(z.number())
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n) && n > 0, {
      message: "المبلغ يجب أن يكون رقمًا موجبًا صالحًا",
    }),
  referenceNumber: z.string().optional().default(""),
  notes: z.string().optional().default(""),
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
  const file = form.get("receipt") as File | null;
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
  if (file.size > MAX_PRIVATE_RECEIPT_SIZE) {
    return NextResponse.json(
      { ok: false, error: "حجم الصورة يجب أن لا يتجاوز 5 ميجابايت" },
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
  const { courseId, bankName, amount, referenceNumber, notes } = parsed;

  // Course lookup
  let course;
  try {
    course = await db.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        titleAr: true,
        title: true,
        price: true,
        discountPrice: true,
        isFree: true,
        currency: true,
        status: true,
        instructorId: true,
      },
    });
  } catch {
    return NextResponse.json(
      { ok: false, error: "قاعدة البيانات غير متصلة. حاول لاحقاً." },
      { status: 503 }
    );
  }

  if (!course) {
    return NextResponse.json({ ok: false, error: "الدورة غير موجودة" }, { status: 404 });
  }
  if (course.status !== "PUBLISHED") {
    return NextResponse.json({ ok: false, error: "الدورة غير متاحة للتسجيل" }, { status: 400 });
  }

  // ---------- Server-side expected amount calculation ----------
  // Do NOT trust the student-submitted amount. Compute the expected
  // amount from the course price or discount price (whichever is valid)
  // on the server. The student's submitted amount is recorded separately
  // as `declaredTransferredAmount` in its own DB column.
  //
  // Priority: valid discountPrice > course.price
  // A discountPrice is "valid" if it is a positive number less than
  // the regular price.
  const regularPrice = course.price ? Number(course.price) : 0;
  const discountPrice = course.discountPrice ? Number(course.discountPrice) : null;
  const hasValidDiscount =
    discountPrice !== null &&
    discountPrice > 0 &&
    discountPrice < regularPrice;
  const expectedAmount = hasValidDiscount ? discountPrice! : regularPrice;

  if (course.isFree || expectedAmount === 0) {
    return NextResponse.json(
      { ok: false, error: "هذه الدورة مجانية ولا تتطلب إيصال تحويل" },
      { status: 400 }
    );
  }

  // The student-declared amount is what they CLAIM they transferred.
  // It is stored in a SEPARATE column (declaredTransferredAmount), NOT
  // in notes. The instructor compares it against `amount` (the official
  // expected amount) during approval.
  const declaredTransferredAmount = amount;

  // Prevent duplicate enrollment
  const existing = await db.enrollment.findUnique({
    where: { studentId_courseId: { studentId: session.user.id, courseId } },
  });
  if (existing && ["ACTIVE", "PENDING_APPROVAL"].includes(existing.status)) {
    return NextResponse.json(
      { ok: false, error: "أنت مسجّل في هذه الدورة بالفعل" },
      { status: 409 }
    );
  }

  // Read + validate buffer
  const buffer = Buffer.from(await file.arrayBuffer());

  // Upload to private storage
  let uploaded: { objectKey: string; publicUrl: string | null; provider: "minio" | "local"; mime: string; size: number };
  try {
    uploaded = await uploadSecure({
      visibility: "private",
      folder: "private/receipts",
      buffer,
      originalFilename: file.name || "receipt.jpg",
      declaredMime: file.type,
      maxSize: MAX_PRIVATE_RECEIPT_SIZE,
    });
  } catch (err) {
    if (err instanceof StorageError) {
      const msgMap: Record<string, string> = {
        MIME_SPOOFED: "نوع الملف لا يطابق الصيغة المُعلنة",
        MIME_NOT_ALLOWED: "الصيغة غير مدعومة. استخدم JPG أو PNG أو WebP",
        MIME_UNKNOWN: "تعذّر التحقق من نوع الملف",
        FILE_TOO_LARGE: "حجم الصورة يجب أن لا يتجاوز 5 ميجابايت",
        FOLDER_NOT_ALLOWED: "مسار التخزين غير مسموح",
        PATH_UNSAFE: "مسار الملف غير آمن",
      };
      return NextResponse.json(
        { ok: false, error: msgMap[err.code] || "فشل رفع الملف" },
        { status: 400 }
      );
    }
    console.error("[payments/upload] storage error:", err);
    return NextResponse.json({ ok: false, error: "فشل رفع الملف" }, { status: 500 });
  }

  // DB transaction: if either write fails we must delete the uploaded file
  const imageUrl = `/api/files/private/${uploaded.objectKey}`;

  try {
    const result = await db.$transaction(async (tx) => {
      const enrollment = existing
        ? await tx.enrollment.update({
            where: { id: existing.id },
            data: { status: "PENDING_APPROVAL", enrolledAt: new Date() },
          })
        : await tx.enrollment.create({
            data: {
              studentId: session.user.id,
              courseId,
              status: "PENDING_APPROVAL",
            },
          });

      const receipt = await tx.paymentReceipt.create({
        data: {
          enrollmentId: enrollment.id,
          studentId: session.user.id,
          imageUrl,
          bankName,
          // `amount` = server-computed expectedAmount (official amount).
          // `declaredTransferredAmount` = what the student CLAIMS they
          // transferred (stored in a SEPARATE column, NOT in notes).
          amount: expectedAmount,
          declaredTransferredAmount,
          currency: course.currency,
          referenceNumber: referenceNumber || null,
          notes: notes || null,
          status: "PENDING",
        },
      });
      return { enrollment, receipt };
    });

    // Audit
    await writeAudit({
      userId: session.user.id,
      action: "PAYMENT_UPLOAD",
      entity: "PaymentReceipt",
      entityId: result.receipt.id,
      metadata: {
        courseId,
        courseName: course.titleAr || course.title,
        expectedAmount,
        declaredTransferredAmount,
        currency: course.currency,
        bankName,
        storageProvider: uploaded.provider,
        storageObjectKey: uploaded.objectKey,
        realMime: uploaded.mime,
      },
      ipAddress: req.headers.get("x-forwarded-for") || undefined,
      userAgent: req.headers.get("user-agent") || undefined,
    });

    return NextResponse.json({
      ok: true,
      receiptId: result.receipt.id,
      enrollmentId: result.enrollment.id,
      message: "تم رفع الإيصال بنجاح. سيتم مراجعته من المدرّب خلال 24 ساعة.",
    });
  } catch (err) {
    console.error("[payments/upload] DB transaction failed, deleting uploaded file:", err);
    // Clean up the orphaned file using deleteSecure (works for both MinIO and local)
    await deleteSecure(uploaded.objectKey);
    return NextResponse.json(
      { ok: false, error: "فشل حفظ بيانات الإيصال. حاول مرة أخرى." },
      { status: 500 }
    );
  }
}
