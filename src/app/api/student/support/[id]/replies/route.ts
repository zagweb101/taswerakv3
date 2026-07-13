// ====================================================================
// POST /api/student/support/:id/replies
// Add a reply to a ticket (student or admin)
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notify, writeAudit } from "@/lib/services/audit";

const replySchema = z.object({
  body: z.string().min(1, "الرد مطلوب").max(5000),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]).optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });

    const { id } = await params;
    const body = await req.json();
    const parsed = replySchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });

    // Verify ticket exists + access
    const ticket = await db.supportTicket.findUnique({
      where: { id },
      select: { id: true, studentId: true, subject: true },
    });
    if (!ticket) return NextResponse.json({ ok: false, error: "التذكرة غير موجودة" }, { status: 404 });

    const isAdmin = session.user.role === "ADMIN";
    if (!isAdmin && ticket.studentId !== session.user.id) {
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });
    }

    const reply = await db.ticketReply.create({
      data: {
        ticketId: id,
        authorId: session.user.id,
        authorRole: isAdmin ? "ADMIN" : "STUDENT",
        body: parsed.data.body,
      },
    });

    // Update ticket status if provided
    if (parsed.data.status) {
      await db.supportTicket.update({ where: { id }, data: { status: parsed.data.status } });
    }

    // Notify the other party
    if (isAdmin) {
      await notify({
        userId: ticket.studentId,
        title: "رد جديد على تذكرتك 💬",
        body: `رد فريق الدعم على: ${ticket.subject}`,
        type: "SYSTEM",
        link: "/student/support",
      });
    } else {
      const admin = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
      if (admin) {
        await notify({
          userId: admin.id,
          title: "رد جديد على تذكرة 💬",
          body: `الطالب ردّ على: ${ticket.subject}`,
          type: "SYSTEM",
          link: "/admin/support",
        });
      }
    }

    return NextResponse.json({ ok: true, reply });
  } catch (err) {
    console.error("[ticket reply] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
