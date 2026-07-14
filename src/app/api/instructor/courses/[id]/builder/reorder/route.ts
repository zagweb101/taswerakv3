// src/app/api/instructor/courses/[id]/builder/reorder/route.ts

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

// Expected payload structure
const reorderSchema = z.object({
  sections: z.array(
    z.object({
      id: z.string(),
      order: z.number().int().min(0),
      lessons: z.array(
        z.object({
          id: z.string(),
          order: z.number().int().min(0),
        })
      ),
    })
  ),
});

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ ok: false, error: "غير مسجّل" }, { status: 401 });
    }
    if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN") {
      return NextResponse.json({ ok: false, error: "صلاحيات غير كافية" }, { status: 403 });
    }

    const body = await req.json();
    const parsed = reorderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: parsed.error.issues[0]?.message }, { status: 400 });
    }

    // Extract courseId from URL
    const match = req.nextUrl.pathname.match(/\/api\/instructor\/courses\/([^/]+)\//);
    const courseId = match?.[1];
    if (!courseId) {
      return NextResponse.json({ ok: false, error: "معرف الدورة غير صالح" }, { status: 400 });
    }

    // Verify ownership
    const course = await db.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) {
      return NextResponse.json({ ok: false, error: "الدورة غير موجودة" }, { status: 404 });
    }
    if (session.user.role === "INSTRUCTOR" && course.instructorId !== session.user.id) {
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });
    }

    // Transactional updates for sections and lessons order
    const sectionCount = parsed.data.sections.length;
    let lessonCount = 0;
    parsed.data.sections.forEach(s => { lessonCount += s.lessons.length; });

    await db.$transaction(async (prisma) => {
      for (const sec of parsed.data.sections) {
        await prisma.section.update({ where: { id: sec.id }, data: { order: sec.order } });
        for (const les of sec.lessons) {
          await prisma.lesson.update({ where: { id: les.id }, data: { order: les.order } });
        }
      }
    });

    await writeAudit({
      userId: session.user.id,
      action: "BUILDER_REORDER",
      entity: "Course",
      entityId: courseId,
      metadata: { sectionsReordered: sectionCount, lessonsReordered: lessonCount },
    });

    return NextResponse.json({ ok: true, message: "تم حفظ الترتيب" });
  } catch (err) {
    console.error("[builder reorder] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
