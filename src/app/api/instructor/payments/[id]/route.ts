// ====================================================================
// PATCH /api/instructor/payments/:id
// Approve or reject a payment receipt.
// Body: { action: "APPROVE" | "REJECT", rejectionReason?: string }
//
// On APPROVE:
//   1. Set PaymentReceipt.status = APPROVED, reviewerId, reviewedAt
//   2. Set Enrollment.status = ACTIVE
//   3. Write audit log
//   4. Notify student (in-app + email)
//
// On REJECT:
//   1. Set PaymentReceipt.status = REJECTED, reviewerId, reviewedAt, rejectionReason
//   2. Set Enrollment.status = PENDING_PAYMENT (so student can re-upload)
//   3. Write audit log
//   4. Notify student (in-app + email with reason)
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit, notify } from "@/lib/services/audit";
import {
  renderPaymentApprovedEmail,
  renderPaymentRejectedEmail,
} from "@/lib/services/email";

const bodySchema = z.object({
  action: z.enum(["APPROVE", "REJECT"]),
  rejectionReason: z.string().optional(),
}).refine(
  (v) => v.action === "APPROVE" || (v.action === "REJECT" && v.rejectionReason && v.rejectionReason.trim().length > 0),
  { message: "سبب الرفض مطلوب" }
);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN") {
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message || "بيانات غير صحيحة" },
        { status: 400 }
      );
    }
    const { action, rejectionReason } = parsed.data;

    // Load receipt + ensure instructor owns the course
    const receipt = await db.paymentReceipt.findUnique({
      where: { id },
      include: {
        enrollment: {
          include: {
            course: { select: { id: true, titleAr: true, title: true, instructorId: true } },
          },
        },
        student: { select: { id: true, name: true, email: true } },
      },
    });

    if (!receipt) {
      return NextResponse.json({ ok: false, error: "الإيصال غير موجود" }, { status: 404 });
    }
    if (receipt.status !== "PENDING") {
      return NextResponse.json(
        { ok: false, error: "تمت مراجعة هذا الإيصال مسبقاً" },
        { status: 409 }
      );
    }

    // Authorization: instructor must own the course (admin can override)
    if (
      session.user.role === "INSTRUCTOR" &&
      (!receipt.enrollment || receipt.enrollment.course.instructorId !== session.user.id)
    ) {
      return NextResponse.json(
        { ok: false, error: "لا تملك صلاحية مراجعة هذا الإيصال" },
        { status: 403 }
      );
    }

    const now = new Date();
    const courseName = receipt.enrollment?.course.titleAr || receipt.enrollment?.course.title || "دورة";

    if (action === "APPROVE") {
      // ---------- Amount mismatch check ----------
      // Prevent approval if the student's declaredTransferredAmount does
      // NOT match the official expected amount — UNLESS the instructor
      // explicitly allows a partial payment by passing
      // `allowPartialPayment: true` in the request body.
      const expectedAmount = Number(receipt.amount);
      const declaredAmount = receipt.declaredTransferredAmount
        ? Number(receipt.declaredTransferredAmount)
        : null;

      const allowPartialPayment = !!(body as any)?.allowPartialPayment === true;

      if (
        declaredAmount !== null &&
        declaredAmount !== expectedAmount &&
        !allowPartialPayment
      ) {
        return NextResponse.json(
          {
            ok: false,
            error: `المبلغ المعلن (${declaredAmount} ${receipt.currency}) لا يطابق المبلغ المطلوب (${expectedAmount} ${receipt.currency}). لا يمكن الاعتماد إلا عبر تفعيل الدفع الجزئي.`,
            code: "AMOUNT_MISMATCH",
            expectedAmount,
            declaredTransferredAmount: declaredAmount,
          },
          { status: 409 }
        );
      }

      // Update receipt
      await db.paymentReceipt.update({
        where: { id },
        data: {
          status: "APPROVED",
          reviewerId: session.user.id,
          reviewedAt: now,
        },
      });
      // Activate enrollment (if still linked)
      if (receipt.enrollmentId) {
        await db.enrollment.update({
          where: { id: receipt.enrollmentId },
          data: { status: "ACTIVE" },
        });
      }

      await writeAudit({
        userId: session.user.id,
        action: "PAYMENT_APPROVE",
        entity: "PaymentReceipt",
        entityId: receipt.id,
        metadata: {
          studentId: receipt.studentId,
          studentName: receipt.student.name,
          courseName,
          amount: Number(receipt.amount),
          currency: receipt.currency,
        },
        ipAddress: req.headers.get("x-forwarded-for") || undefined,
        userAgent: req.headers.get("user-agent") || undefined,
      });

      await notify({
        userId: receipt.studentId,
        title: "تم اعتماد دفعتك ✅",
        body: `تم اعتماد دفعتك لدورة "${courseName}". يمكنك الآن البدء في الدورة.`,
        type: "PAYMENT_APPROVED",
        link: "/student/courses",
        email: {
          to: receipt.student.email,
          payload: renderPaymentApprovedEmail({
            studentName: receipt.student.name || "طالب",
            courseName,
            amount: Number(receipt.amount),
            currency: receipt.currency,
          }),
        },
      });

      return NextResponse.json({
        ok: true,
        action: "APPROVED",
        message: "تم اعتماد الدفعة وتفعيل التسجيل",
      });
    } else {
      // REJECT
      await db.paymentReceipt.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewerId: session.user.id,
          reviewedAt: now,
          rejectionReason: rejectionReason || null,
        },
      });
      // Reset enrollment to PENDING_PAYMENT so student can re-upload
      if (receipt.enrollmentId) {
        await db.enrollment.update({
          where: { id: receipt.enrollmentId },
          data: { status: "PENDING_PAYMENT" },
        });
      }

      await writeAudit({
        userId: session.user.id,
        action: "PAYMENT_REJECT",
        entity: "PaymentReceipt",
        entityId: receipt.id,
        metadata: {
          studentId: receipt.studentId,
          studentName: receipt.student.name,
          courseName,
          amount: Number(receipt.amount),
          currency: receipt.currency,
          rejectionReason,
        },
        ipAddress: req.headers.get("x-forwarded-for") || undefined,
        userAgent: req.headers.get("user-agent") || undefined,
      });

      await notify({
        userId: receipt.studentId,
        title: "تحتاج دفعتك لمراجعة ⚠️",
        body: `لم نتمكن من اعتماد دفعتك لدورة "${courseName}". السبب: ${rejectionReason}`,
        type: "PAYMENT_REJECTED",
        link: "/student/payments",
        email: {
          to: receipt.student.email,
          payload: renderPaymentRejectedEmail({
            studentName: receipt.student.name || "طالب",
            courseName,
            amount: Number(receipt.amount),
            currency: receipt.currency,
            rejectionReason: rejectionReason || "",
          }),
        },
      });

      return NextResponse.json({
        ok: true,
        action: "REJECTED",
        message: "تم رفض الدفعة وإشعار الطالب",
      });
    }
  } catch (err) {
    console.error("[payments/review] error:", err);
    return NextResponse.json(
      { ok: false, error: "حدث خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
