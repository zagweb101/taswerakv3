// ====================================================================
// Taswerak — Authorization helpers
//
// Centralized RBAC checks so routes don't repeat the same auth logic.
// Every helper returns a result object — routes branch on .ok.
//
// Usage:
//   import { requireStudent, requireInstructorForCourse } from "@/lib/authz";
//   const authz = await requireInstructorForCourse(session, courseId);
//   if (!authz.ok) return apiError(authz.error, authz.code);
// ====================================================================

import { db } from "@/lib/db";
import type { Role } from "@prisma/client";

export interface AuthzResult {
  ok: boolean;
  code?: number;
  error?: string;
  userId?: string;
  role?: Role;
}

/** Require any authenticated user */
export async function requireAuth(session: any): Promise<AuthzResult> {
  if (!session?.user?.id) return { ok: false, code: 401, error: "غير مسجّل" };
  return { ok: true, userId: session.user.id, role: session.user.role };
}

/** Require STUDENT role */
export async function requireStudent(session: any): Promise<AuthzResult> {
  const base = await requireAuth(session);
  if (!base.ok) return base;
  if (session.user.role !== "STUDENT") {
    return { ok: false, code: 403, error: "هذه العملية للطلاب فقط" };
  }
  return base;
}

/** Require INSTRUCTOR or ADMIN */
export async function requireInstructorOrAdmin(session: any): Promise<AuthzResult> {
  const base = await requireAuth(session);
  if (!base.ok) return base;
  if (session.user.role !== "INSTRUCTOR" && session.user.role !== "ADMIN") {
    return { ok: false, code: 403, error: "صلاحيات غير كافية" };
  }
  return base;
}

/** Require ADMIN */
export async function requireAdmin(session: any): Promise<AuthzResult> {
  const base = await requireAuth(session);
  if (!base.ok) return base;
  if (session.user.role !== "ADMIN") {
    return { ok: false, code: 403, error: "هذه العملية للمدير فقط" };
  }
  return base;
}

/** Require INSTRUCTOR who owns the course, or ADMIN */
export async function requireInstructorForCourse(
  session: any,
  courseId: string
): Promise<AuthzResult> {
  const base = await requireInstructorOrAdmin(session);
  if (!base.ok) return base;

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { instructorId: true },
  });
  if (!course) return { ok: false, code: 404, error: "الدورة غير موجودة" };

  if (session.user.role === "INSTRUCTOR" && course.instructorId !== session.user.id) {
    return { ok: false, code: 403, error: "لا تملك صلاحية على هذه الدورة" };
  }
  return base;
}

/** Require STUDENT enrolled (ACTIVE) in the course */
export async function requireEnrolledStudent(
  session: any,
  courseId: string
): Promise<AuthzResult> {
  const base = await requireStudent(session);
  if (!base.ok) return base;

  const enr = await db.enrollment.findUnique({
    where: { studentId_courseId: { studentId: session.user.id, courseId } },
    select: { id: true, status: true },
  });
  if (!enr || enr.status !== "ACTIVE") {
    return { ok: false, code: 403, error: "غير مسجّل في هذه الدورة" };
  }
  return base;
}
