// ====================================================================
// /api/courses/[courseId]/builder/lessons
// CRUD for lessons within a course.
//
// Authorization: INSTRUCTOR (course owner) or ADMIN only.
// Every method verifies the caller owns the course before mutating.
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
  sectionId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().optional().default(""),
  type: z.enum(["VIDEO", "TEXT", "PDF", "LIVE", "ARTICLE", "QUIZ", "ASSIGNMENT", "RESOURCE"]).default("VIDEO"),
  videoUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  pdfUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  thumbnailUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  isPreview: z.boolean().default(false),
  isPublished: z.boolean().default(true),
  settings: z.record(z.string(), z.any()).optional(),
});

const updateSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  description: z.string().optional(),
  type: z.enum(["VIDEO", "TEXT", "PDF", "LIVE", "ARTICLE", "QUIZ", "ASSIGNMENT", "RESOURCE"]).optional(),
  videoUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  pdfUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  thumbnailUrl: z.string().url().optional().or(z.literal("").transform(() => null)),
  isPreview: z.boolean().optional(),
  isPublished: z.boolean().optional(),
  order: z.number().int().min(0).optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

const deleteSchema = z.object({ id: z.string().min(1) });

// ---------- GET: list lessons (auth: instructor/admin/student-enrolled) ----------
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ courseId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
  }
  const { courseId } = await params;
  const { searchParams } = new URL(request.url);
  const sectionId = searchParams.get("sectionId");

  // Instructors/Admins: must own the course
  if (session.user.role === "INSTRUCTOR" || session.user.role === "ADMIN") {
    const authz = await authorizeCourseEdit(courseId, session);
    if (!authz.ok) return NextResponse.json({ ok: false, error: authz.error }, { status: authz.code });
  } else if (session.user.role === "STUDENT") {
    // Students: must be enrolled
    const enr = await db.enrollment.findUnique({
      where: { studentId_courseId: { studentId: session.user.id, courseId } },
      select: { id: true },
    });
    if (!enr) {
      return NextResponse.json({ ok: false, error: "غير مسجّل في هذه الدورة" }, { status: 403 });
    }
  }

  const whereClause: any = { courseId };
  if (sectionId) whereClause.sectionId = sectionId;
  const lessons = await db.lesson.findMany({
    where: whereClause,
    orderBy: { order: "asc" },
  });
  return NextResponse.json({ ok: true, data: lessons });
}

// ---------- POST: create lesson (auth: instructor/admin) ----------
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

  // Verify the section belongs to this course
  const section = await db.section.findUnique({
    where: { id: data.sectionId },
    select: { courseId: true },
  });
  if (!section || section.courseId !== courseId) {
    return NextResponse.json({ ok: false, error: "القسم غير تابع لهذه الدورة" }, { status: 400 });
  }

  const maxOrder = await db.lesson.aggregate({
    where: { sectionId: data.sectionId },
    _max: { order: true },
  });
  const newLesson = await db.lesson.create({
    data: {
      courseId,
      sectionId: data.sectionId,
      title: data.title,
      description: data.description,
      type: data.type,
      videoUrl: data.videoUrl ?? null,
      pdfUrl: data.pdfUrl ?? null,
      thumbnailUrl: data.thumbnailUrl ?? null,
      isPreview: data.isPreview,
      isPublished: data.isPublished,
      order: (maxOrder._max?.order ?? 0) + 1,
      settings: data.settings,
      slug: `${data.title.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
    },
  });

  await writeAudit({
    userId: session!.user.id,
    action: "LESSON_CREATE",
    entity: "Lesson",
    entityId: newLesson.id,
    metadata: { courseId, sectionId: data.sectionId, title: data.title },
  });

  return NextResponse.json({ ok: true, data: newLesson }, { status: 201 });
}

// ---------- PATCH: update lesson (auth: instructor/admin) ----------
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

  // Verify the lesson belongs to this course
  const existing = await db.lesson.findUnique({
    where: { id: data.id },
    select: { courseId: true },
  });
  if (!existing || existing.courseId !== courseId) {
    return NextResponse.json({ ok: false, error: "الدرس غير تابع لهذه الدورة" }, { status: 400 });
  }

  const { id, ...updateData } = data;
  const updated = await db.lesson.update({
    where: { id },
    data: updateData,
  });

  await writeAudit({
    userId: session!.user.id,
    action: "LESSON_UPDATE",
    entity: "Lesson",
    entityId: id,
    metadata: { courseId, fields: Object.keys(updateData) },
  });

  return NextResponse.json({ ok: true, data: updated });
}

// ---------- DELETE: delete lesson (auth: instructor/admin) ----------
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
    return NextResponse.json({ ok: false, error: "معرف الدرس مطلوب" }, { status: 400 });
  }
  const { id } = parsed.data;

  // Verify ownership
  const existing = await db.lesson.findUnique({
    where: { id },
    select: { courseId: true, title: true },
  });
  if (!existing || existing.courseId !== courseId) {
    return NextResponse.json({ ok: false, error: "الدرس غير تابع لهذه الدورة" }, { status: 400 });
  }

  await db.lesson.delete({ where: { id } });

  await writeAudit({
    userId: session!.user.id,
    action: "LESSON_DELETE",
    entity: "Lesson",
    entityId: id,
    metadata: { courseId, title: existing.title },
  });

  return NextResponse.json({ ok: true });
}
