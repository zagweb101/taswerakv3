// ====================================================================
// PATCH /api/student/progress
// Body: { courseId, lessonId, completed: boolean }
// Updates Enrollment.progress + lastLessonId
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const schema = z.object({
  courseId: z.string().min(1),
  lessonId: z.string().min(1),
  completed: z.boolean(),
});

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    }
    if (session.user.role !== "STUDENT") {
      return NextResponse.json({ ok: false, error: "هذه العملية للطلاب فقط" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: parsed.error.issues[0]?.message || "بيانات غير صحيحة" },
        { status: 400 }
      );
    }
    const { courseId, lessonId, completed } = parsed.data;

    // Verify enrollment
    const enrollment = await db.enrollment.findUnique({
      where: {
        studentId_courseId: { studentId: session.user.id, courseId },
      },
      include: {
        course: {
          include: {
            sections: {
              include: { lessons: { select: { id: true } } },
            },
          },
        },
      },
    });

    if (!enrollment || enrollment.status !== "ACTIVE") {
      return NextResponse.json({ ok: false, error: "غير مسجّل في هذه الدورة" }, { status: 403 });
    }

    // Count total lessons
    const totalLessons = enrollment.course.sections.reduce(
      (sum: number, s: any) => sum + s.lessons.length,
      0
    );

    // Update lastLessonId
    const updateData: any = { lastLessonId: lessonId };

    // If marked complete, recalculate progress based on ACTUAL completed lessons
    if (completed && totalLessons > 0) {
      // Count unique completed lessons from the database
      const completedLessonsCount = await db.lessonProgress.count({
        where: {
          studentId: session.user.id,
          courseId,
          completedAt: { not: null },
        },
      });
      updateData.progress = Math.min(100, Math.round((completedLessonsCount / totalLessons) * 100));
      if (updateData.progress >= 100) {
        updateData.completedAt = new Date();
      }
    }

    const updated = await db.enrollment.update({
      where: { id: enrollment.id },
      data: updateData,
    });

    return NextResponse.json({
      ok: true,
      progress: updated.progress,
      completedAt: updated.completedAt,
    });
  } catch (err) {
    console.error("[progress] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
