// ====================================================================
// PATCH/DELETE /api/instructor/lessons/:id
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const updateSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional().nullable(),
  type: z.enum(["VIDEO", "TEXT", "PDF", "LIVE"]).optional(),
  videoUrl: z.string().url().optional().nullable(),
  pdfUrl: z.string().url().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  duration: z.number().min(0).optional(),
  order: z.number().min(0).optional(),
  isPreview: z.boolean().optional(),
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

    const lesson = await db.lesson.findUnique({
      where: { id },
      include: { course: { select: { instructorId: true } } },
    });
    if (!lesson) return NextResponse.json({ ok: false, error: "الدرس غير موجود" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && lesson.course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    const data: any = { ...parsed.data };
    if (data.videoUrl !== undefined) data.videoUrl = data.videoUrl || null;
    if (data.pdfUrl !== undefined) data.pdfUrl = data.pdfUrl || null;
    if (data.thumbnailUrl !== undefined) data.thumbnailUrl = data.thumbnailUrl || null;
    if (data.description !== undefined) data.description = data.description || null;

    const updated = await db.lesson.update({ where: { id }, data });

    return NextResponse.json({ ok: true, lesson: updated });
  } catch (err) {
    console.error("[lesson PATCH] error:", err);
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
    const lesson = await db.lesson.findUnique({
      where: { id },
      include: { course: { select: { instructorId: true } } },
    });
    if (!lesson) return NextResponse.json({ ok: false, error: "الدرس غير موجود" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && lesson.course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    await db.lesson.delete({ where: { id } });

    return NextResponse.json({ ok: true, message: "تم حذف الدرس" });
  } catch (err) {
    console.error("[lesson DELETE] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
