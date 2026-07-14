// ====================================================================
// Lessons API
// POST   /api/instructor/lessons              → Create lesson
// PATCH  /api/instructor/lessons/:id          → Update lesson (incl. video upload)
// DELETE /api/instructor/lessons/:id          → Delete lesson
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const createSchema = z.object({
  sectionId: z.string().min(1),
  courseId: z.string().min(1),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  type: z.enum(["VIDEO", "TEXT", "PDF", "LIVE"]).default("VIDEO"),
  videoUrl: z.string().url().optional().nullable(),
  pdfUrl: z.string().url().optional().nullable(),
  thumbnailUrl: z.string().url().optional().nullable(),
  duration: z.number().min(0).default(0),
  order: z.number().min(0).default(0),
  isPreview: z.boolean().default(false),
  isPublished: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN")
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });

    const body = await req.json();
    const parsed = createSchema.safeParse(body);
    if (!parsed.success)
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });

    const { sectionId, courseId, title, description, type, videoUrl, pdfUrl, thumbnailUrl, duration, order, isPreview, isPublished } = parsed.data;

    // Verify ownership
    const course = await db.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) return NextResponse.json({ ok: false, error: "الدورة غير موجودة" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    // Generate slug
    const slugBase = title.toLowerCase().replace(/[^\u0600-\u06FFa-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || `lesson-${Date.now()}`;
    let slug = slugBase;
    let suffix = 1;
    while (await db.lesson.findUnique({ where: { courseId_slug: { courseId, slug } } })) {
      slug = `${slugBase}-${suffix++}`;
    }

    const lesson = await db.lesson.create({
      data: {
        sectionId,
        courseId,
        title,
        slug,
        description: description || null,
        type,
        videoUrl: videoUrl || null,
        pdfUrl: pdfUrl || null,
        thumbnailUrl: thumbnailUrl || null,
        duration,
        order,
        isPreview,
        isPublished,
      },
    });

    await writeAudit({
      userId: session.user.id,
      action: "LESSON_CREATE",
      entity: "Lesson",
      entityId: lesson.id,
      metadata: { courseId, sectionId, title, type },
    });

    return NextResponse.json({ ok: true, lesson });
  } catch (err) {
    console.error("[lessons POST] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
