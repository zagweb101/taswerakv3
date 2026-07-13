// ====================================================================
// PATCH/DELETE /api/instructor/sections/:id
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const updateSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  titleAr: z.string().max(120).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  order: z.number().min(0).optional(),
  isPublished: z.boolean().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN")
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });

    const { id } = await params;
    const body = await req.json();
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });

    const section = await db.section.findUnique({
      where: { id },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) return NextResponse.json({ ok: false, error: "القسم غير موجود" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && section.course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    const updated = await db.section.update({
      where: { id },
      data: {
        ...parsed.data,
        titleAr: parsed.data.titleAr !== undefined ? (parsed.data.titleAr || null) : undefined,
        description: parsed.data.description !== undefined ? (parsed.data.description || null) : undefined,
      },
    });

    return NextResponse.json({ ok: true, section: updated });
  } catch (err) {
    console.error("[section PATCH] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN")
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });

    const { id } = await params;
    const section = await db.section.findUnique({
      where: { id },
      include: { course: { select: { instructorId: true } } },
    });
    if (!section) return NextResponse.json({ ok: false, error: "القسم غير موجود" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && section.course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    await db.section.delete({ where: { id } });

    return NextResponse.json({ ok: true, message: "تم حذف القسم ودروسه" });
  } catch (err) {
    console.error("[section DELETE] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
