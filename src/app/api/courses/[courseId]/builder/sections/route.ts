// ====================================================================
// /api/courses/[courseId]/builder/sections
// CRUD for sections within a course.
//
// Authorization: INSTRUCTOR (course owner) or ADMIN only.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

// ---------- Authorization helper ----------
async function authorizeCourseEdit(courseId: string, session: any) {
  if (!session?.user?.id) return { ok: false, code: 401, error: "غير مسجّل" };
  if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN") {
    return { ok: false, code: 403, error: "صلاحيات غير كافية" };
  }
  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { instructorId: true },
  });
  if (!course) return { ok: false, code: 404, error: "الدورة غير موجودة" };
  if (session.user.role === "INSTRUCTOR" && course.instructorId !== session.user.id) {
    return { ok: false, code: 403, error: "لا تملك صلاحية على هذه الدورة" };
  }
  return { ok: true };
}

// ---------- Schemas ----------
const createSchema = z.object({
  title: z.string().min(1).max(200),
  titleAr: z.string().optional(),
  description: z.string().optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  titleAr: z.string().optional(),
  description: z.string().optional(),
  order: z.number().int().min(0).optional(),
});

const deleteSchema = z.object({ id: z.string().min(1) });

// ---------- GET ----------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
  }
  const { courseId } = await params;

  if (session.user.role === "INSTRUCTOR" || session.user.role === "ADMIN") {
    const authz = await authorizeCourseEdit(courseId, session);
    if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.code });
  } else if (session.user.role === "STUDENT") {
    const enr = await db.enrollment.findUnique({
      where: { studentId_courseId: { studentId: session.user.id, courseId } },
      select: { id: true },
    });
    if (!enr) {
      return NextResponse.json({ ok: false, error: "غير مسجّل في هذه الدورة" }, { status: 403 });
    }
  }

  const sections = await db.section.findMany({
    where: { courseId },
    orderBy: { order: "asc" },
    include: { lessons: { orderBy: { order: "asc" } } },
  });
  return NextResponse.json({ ok: true, data: sections });
}

// ---------- POST ----------
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  const { courseId } = await params;
  const authz = await authorizeCourseEdit(courseId, session);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.code });

  const body = await request.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message || "بيانات غير صحيحة" },
      { status: 400 }
    );
  }
  const data = parsed.data;

  const maxOrder = await db.section.aggregate({
    where: { courseId },
    _max: { order: true },
  });
  const newSection = await db.section.create({
    data: {
      courseId,
      title: data.title,
      titleAr: data.titleAr,
      description: data.description,
      order: (maxOrder._max?.order ?? 0) + 1,
    },
  });

  await writeAudit({
    userId: session!.user.id,
    action: "SECTION_CREATE",
    entity: "Section",
    entityId: newSection.id,
    metadata: { courseId, title: data.title },
  });

  return NextResponse.json({ ok: true, data: newSection }, { status: 201 });
}

// ---------- PATCH ----------
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  const { courseId } = await params;
  const authz = await authorizeCourseEdit(courseId, session);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.code });

  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message || "بيانات غير صحيحة" },
      { status: 400 }
    );
  }
  const data = parsed.data;

  // Verify the section belongs to this course
  const existing = await db.section.findUnique({
    where: { id: data.id },
    select: { courseId: true },
  });
  if (!existing || existing.courseId !== courseId) {
    return NextResponse.json({ ok: false, error: "القسم غير تابع لهذه الدورة" }, { status: 400 });
  }

  const { id, ...updateData } = data;
  const updated = await db.section.update({
    where: { id },
    data: updateData,
  });

  await writeAudit({
    userId: session!.user.id,
    action: "SECTION_UPDATE",
    entity: "Section",
    entityId: id,
    metadata: { courseId, fields: Object.keys(updateData) },
  });

  return NextResponse.json({ ok: true, data: updated });
}

// ---------- DELETE ----------
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  const { courseId } = await params;
  const authz = await authorizeCourseEdit(courseId, session);
  if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.code });

  const body = await request.json();
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "معرف القسم مطلوب" }, { status: 400 });
  }
  const { id } = parsed.data;

  const existing = await db.section.findUnique({
    where: { id },
    select: { courseId: true, title: true },
  });
  if (!existing || existing.courseId !== courseId) {
    return NextResponse.json({ ok: false, error: "القسم غير تابع لهذه الدورة" }, { status: 400 });
  }

  await db.section.delete({ where: { id } });

  await writeAudit({
    userId: session!.user.id,
    action: "SECTION_DELETE",
    entity: "Section",
    entityId: id,
    metadata: { courseId, title: existing.title },
  });

  return NextResponse.json({ ok: true });
}
