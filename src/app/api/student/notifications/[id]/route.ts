// ====================================================================
// PATCH /api/student/notifications/:id
// Mark a notification as read
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    }
    if (session.user.role !== "STUDENT") {
      return NextResponse.json({ ok: false, error: "هذه العملية للطلاب فقط" }, { status: 403 });
    }

    const { id } = await params;

    // Verify ownership
    const notification = await db.notification.findUnique({
      where: { id },
      select: { id: true, userId: true, readAt: true },
    });

    if (!notification) {
      return NextResponse.json({ ok: false, error: "الإشعار غير موجود" }, { status: 404 });
    }

    if (notification.userId !== session.user.id) {
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });
    }

    if (notification.readAt) {
      return NextResponse.json({ ok: true, message: "الإشعار مقروء بالفعل" });
    }

    await db.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });

    return NextResponse.json({ ok: true, message: "تم تعليم الإشعار كمقروء" });
  } catch (err) {
    console.error("[notification/read] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
