// ====================================================================
// PATCH /api/student/lesson-progress
// Body: { lessonId, courseId, watchedSeconds, completed }
// Upserts lesson progress for the current student
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const schema = z.object({
  lessonId: z.string().min(1),
  courseId: z.string().min(1),
  watchedSeconds: z.number().min(0).optional(),
  completed: z.boolean().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "STUDENT") return NextResponse.json({ ok: false, error: "للطلاب فقط" }, { status: 403 });

    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });

    const { lessonId, courseId, watchedSeconds, completed } = parsed.data;

    // Verify student is enrolled in this course
    const enrollment = await db.enrollment.findUnique({
      where: { studentId_courseId: { studentId: session.user.id, courseId } },
    });
    if (!enrollment || enrollment.status !== "ACTIVE") {
      return NextResponse.json({ ok: false, error: "غير مسجّل في هذه الدورة" }, { status: 403 });
    }

    const progress = await db.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId: session.user.id, lessonId } },
      create: {
        studentId: session.user.id,
        lessonId,
        courseId,
        watchedSeconds: watchedSeconds || 0,
        completedAt: completed ? new Date() : null,
      },
      update: {
        ...(watchedSeconds !== undefined && { watchedSeconds }),
        ...(completed && { completedAt: new Date() }),
        lastWatchedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true, progress });
  } catch (err) {
    console.error("[lesson-progress] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}

// GET — for instructor to see course analytics
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN")
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });

    const { searchParams } = new URL(req.url);
    const courseId = searchParams.get("courseId");
    if (!courseId) return NextResponse.json({ ok: false, error: "courseId مطلوب" }, { status: 400 });

    // Verify instructor owns this course (skip for admin)
    if (session.user.role === "INSTRUCTOR") {
      const course = await db.course.findUnique({
        where: { id: courseId },
        select: { instructorId: true },
      });
      if (!course || course.instructorId !== session.user.id) {
        return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });
      }
    }

    const progress = await db.lessonProgress.findMany({
      where: { courseId },
    });

    // Fetch lesson titles separately
    const lessonIds = [...new Set(progress.map((p) => p.lessonId))];
    const lessons = await db.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: { id: true, title: true, order: true, duration: true },
    });
    const lessonMap = new Map(lessons.map((l) => [l.id, l]));

    // Aggregate per lesson
    const byLesson = progress.reduce((acc, p) => {
      const key = p.lessonId;
      if (!acc[key]) {
        acc[key] = {
          lessonId: key,
          lessonTitle: lessonMap.get(key)?.title || "",
          totalWatched: 0,
          completedCount: 0,
          totalStudents: 0,
          avgWatchedSeconds: 0,
        };
      }
      acc[key].totalWatched += p.watchedSeconds;
      acc[key].totalStudents += 1;
      if (p.completedAt) acc[key].completedCount += 1;
      return acc;
    }, {} as Record<string, any>);

    const analytics = Object.values(byLesson).map((l: any) => ({
      ...l,
      avgWatchedSeconds: l.totalStudents > 0 ? Math.round(l.totalWatched / l.totalStudents) : 0,
      completionRate: l.totalStudents > 0 ? Math.round((l.completedCount / l.totalStudents) * 100) : 0,
    }));

    return NextResponse.json({ ok: true, analytics });
  } catch (err) {
    console.error("[lesson-analytics] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
