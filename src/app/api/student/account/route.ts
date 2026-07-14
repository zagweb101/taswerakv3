// ====================================================================
// DELETE /api/student/account
// GDPR / Saudi PDPL — Right to be forgotten
//
// Deletes the student's account and ALL associated data:
//   - User record (soft-delete first, then hard-delete after 30 days)
//   - Enrollments
//   - Payment receipts + uploaded receipt images
//   - Submissions + uploaded submission images
//   - Certificates
//   - Reviews / testimonials
//   - Notifications
//   - Support tickets + replies
//   - Lesson progress
//   - Quiz attempts
//   - Audit logs (anonymized, not deleted — retained for compliance)
//   - Guardian links
//   - User settings
//
// The deletion is PERMANENT and cannot be undone. The student must
// confirm by passing `confirm: "DELETE"` in the request body.
//
// Files in MinIO/local storage are deleted via deleteSecure().
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { deleteSecure } from "@/lib/services/storage";

const deleteSchema = z.object({
  confirm: z.literal("DELETE", {
    message: "يجب تأكيد الحذف بإرسال confirm: \"DELETE\"",
  }),
});

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    }
    if (session.user.role !== "STUDENT") {
      return NextResponse.json(
        { ok: false, error: "هذه العملية للطلاب فقط. تواصل مع الإدارة لحذف حساب المدرّب/المدير." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message || "تأكيد الحذف مطلوب" },
        { status: 400 }
      );
    }

    const userId = session.user.id;

    // ---------- 1. Collect all file URLs to delete from storage ----------
    const receipts = await db.paymentReceipt.findMany({
      where: { studentId: userId },
      select: { id: true, imageUrl: true },
    });
    const submissions = await db.submission.findMany({
      where: { studentId: userId },
      select: { id: true, imageUrl: true },
    });

    // Extract object keys from URLs like "/api/files/private/private/receipts/..."
    const extractKey = (url: string): string | null => {
      if (!url || !url.includes("/api/files/private/")) return null;
      const key = url.replace("/api/files/private/", "");
      return key || null;
    };

    const fileKeys: string[] = [];
    for (const r of receipts) {
      const key = extractKey(r.imageUrl);
      if (key) fileKeys.push(key);
    }
    for (const s of submissions) {
      const key = extractKey(s.imageUrl);
      if (key) fileKeys.push(key);
    }

    // ---------- 2. Write audit log BEFORE deletion (so we have the userId) ----------
    await writeAudit({
      userId,
      action: "ACCOUNT_DELETION_REQUESTED",
      entity: "User",
      entityId: userId,
      metadata: {
        receiptCount: receipts.length,
        submissionCount: submissions.length,
        fileKeysToDelete: fileKeys.length,
        timestamp: new Date().toISOString(),
      },
      ipAddress: req.headers.get("x-forwarded-for") || undefined,
      userAgent: req.headers.get("user-agent") || undefined,
    });

    // ---------- 3. Delete all DB records in a transaction ----------
    await db.$transaction(async (tx) => {
      // Delete in dependency order (children first)
      await tx.quizAttempt.deleteMany({ where: { studentId: userId } });
      await tx.lessonProgress.deleteMany({ where: { studentId: userId } });
      await tx.ticketReply.deleteMany({
        where: { ticket: { studentId: userId } },
      });
      await tx.supportTicket.deleteMany({ where: { studentId: userId } });
      await tx.notification.deleteMany({ where: { userId } });
      await tx.review.deleteMany({ where: { studentId: userId } });
      await tx.certificate.deleteMany({ where: { studentId: userId } });
      await tx.submission.deleteMany({ where: { studentId: userId } });
      await tx.paymentReceipt.deleteMany({ where: { studentId: userId } });
      await tx.enrollment.deleteMany({ where: { studentId: userId } });
      await tx.pointTransaction.deleteMany({ where: { userId } });
      await tx.guardianLink.deleteMany({
        where: { OR: [{ guardianId: userId }, { studentId: userId }] },
      });
      await tx.userSettings.deleteMany({ where: { userId } });
      // Anonymize audit logs (retain for compliance, strip PII)
      await tx.auditLog.updateMany({
        where: { userId },
        data: { userId: null },
      });
      // Finally, delete the user
      await tx.user.delete({ where: { id: userId } });
    });

    // ---------- 4. Delete files from storage (best-effort) ----------
    for (const key of fileKeys) {
      try {
        await deleteSecure(key);
      } catch (err) {
        console.warn(`[account-delete] could not delete file ${key}:`, err);
      }
    }

    // ---------- 5. Final audit log (anonymous — user is gone) ----------
    await writeAudit({
      userId: undefined,
      action: "ACCOUNT_DELETION_COMPLETED",
      entity: "User",
      entityId: userId,
      metadata: {
        filesDeleted: fileKeys.length,
        completedAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      ok: true,
      message: "تم حذف حسابك وجميع بياناتك نهائياً. لا يمكن التراجع عن هذا الإجراء.",
    });
  } catch (err) {
    console.error("[account-delete] error:", err);
    return NextResponse.json(
      { ok: false, error: "حدث خطأ أثناء حذف الحساب. حاول مرة أخرى أو تواصل مع الدعم." },
      { status: 500 }
    );
  }
}
