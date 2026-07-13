// ====================================================================
// POST   /api/student/support          → Create ticket
// GET    /api/student/support          → List student's tickets
// GET    /api/student/support/:id      → Get ticket + replies
// POST   /api/student/support/:id/replies → Add reply
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { notify, writeAudit } from "@/lib/services/audit";

const createSchema = z.object({
  subject: z.string().min(3, "الموضوع مطلوب").max(200),
  body: z.string().min(10, "الرسالة قصيرة جداً").max(5000),
  category: z.enum(["GENERAL", "TECHNICAL", "PAYMENT", "REFUND", "OTHER"]).default("GENERAL"),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  courseId: z.string().optional().nullable(),
});

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });

    const tickets = await db.supportTicket.findMany({
      where: session.user.role === "ADMIN" ? {} : { studentId: session.user.id },
      include: {
        student: { select: { name: true, email: true } },
        course: { select: { titleAr: true, title: true } },
        _count: { select: { replies: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ ok: true, tickets });
  } catch (err) {
    console.error("[support GET] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "STUDENT") return NextResponse.json({ ok: false, error: "للطلاب فقط" }, { status: 403 });

    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });

    const ticket = await db.supportTicket.create({
      data: {
        studentId: session.user.id,
        ...parsed.data,
        courseId: parsed.data.courseId || null,
      },
    });

    await writeAudit({
      userId: session.user.id,
      action: "SUPPORT_TICKET_CREATE",
      entity: "SupportTicket",
      entityId: ticket.id,
      metadata: { subject: parsed.data.subject, category: parsed.data.category, priority: parsed.data.priority },
    });

    // Notify admin
    const admin = await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } });
    if (admin) {
      await notify({
        userId: admin.id,
        title: "تذكرة دعم جديدة 🎫",
        body: `${session.user.name}: ${parsed.data.subject}`,
        type: "SYSTEM",
        link: "/admin/support",
      });
    }

    return NextResponse.json({ ok: true, ticket, message: "تم إنشاء التذكرة. سنرد قريباً." });
  } catch (err) {
    console.error("[support POST] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
