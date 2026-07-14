// ====================================================================
// Sections API
// POST   /api/instructor/sections              → Create section
// PATCH  /api/instructor/sections/:id          → Update section
// DELETE /api/instructor/sections/:id          → Delete section (cascade lessons)
// POST   /api/instructor/sections/reorder      → Reorder sections
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";

const createSchema = z.object({
  courseId: z.string().min(1),
  title: z.string().min(1).max(120),
  titleAr: z.string().max(120).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  order: z.number().min(0).default(0),
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

    const { courseId, title, titleAr, description, order } = parsed.data;

    // Verify ownership
    const course = await db.course.findUnique({
      where: { id: courseId },
      select: { instructorId: true },
    });
    if (!course) return NextResponse.json({ ok: false, error: "الدورة غير موجودة" }, { status: 404 });
    if (session.user.role === "INSTRUCTOR" && course.instructorId !== session.user.id)
      return NextResponse.json({ ok: false, error: "غير مصرّح" }, { status: 403 });

    const section = await db.section.create({
      data: { courseId, title, titleAr: titleAr || null, description: description || null, order },
    });

    return NextResponse.json({ ok: true, section });
  } catch (err) {
    console.error("[sections POST] error:", err);
    return NextResponse.json({ ok: false, error: "حدث خطأ غير متوقع" }, { status: 500 });
  }
}
