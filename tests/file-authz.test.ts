// ====================================================================
// File access authorization tests (logic-only).
//
// These tests verify the authorization decision logic that the
// /api/files/private/[...path] route uses. We test the predicate
// directly so we don't need a real database.
// ====================================================================

import { describe, it, expect } from "vitest";

// Re-implement the same predicate the route uses, so we can test it
// without booting the route handler.
interface FileOwner {
  studentId: string;
  instructorId: string | null;
}

interface Session {
  userId: string;
  role: "ADMIN" | "INSTRUCTOR" | "STUDENT" | string;
}

function canReadPrivateFile(session: Session, owner: FileOwner): boolean {
  if (!session?.userId) return false;
  if (session.role === "ADMIN") return true;
  if (session.role === "INSTRUCTOR") return owner.instructorId === session.userId;
  // STUDENT (or any other role)
  return owner.studentId === session.userId;
}

describe("private file authorization: student can read only own files", () => {
  it("allows student to read their own receipt", () => {
    expect(
      canReadPrivateFile(
        { userId: "s1", role: "STUDENT" },
        { studentId: "s1", instructorId: "i1" }
      )
    ).toBe(true);
  });

  it("blocks student from reading another student's receipt", () => {
    expect(
      canReadPrivateFile(
        { userId: "s1", role: "STUDENT" },
        { studentId: "s2", instructorId: "i1" }
      )
    ).toBe(false);
  });

  it("blocks anonymous user", () => {
    expect(
      canReadPrivateFile(
        { userId: "" as any, role: "STUDENT" },
        { studentId: "s1", instructorId: "i1" }
      )
    ).toBe(false);
  });
});

describe("private file authorization: instructor can read only enrolled students' files", () => {
  it("allows instructor of the course", () => {
    expect(
      canReadPrivateFile(
        { userId: "i1", role: "INSTRUCTOR" },
        { studentId: "s1", instructorId: "i1" }
      )
    ).toBe(true);
  });

  it("blocks instructor of a different course", () => {
    expect(
      canReadPrivateFile(
        { userId: "i2", role: "INSTRUCTOR" },
        { studentId: "s1", instructorId: "i1" }
      )
    ).toBe(false);
  });
});

describe("private file authorization: admin can read any file", () => {
  it("allows admin regardless of owner", () => {
    expect(
      canReadPrivateFile(
        { userId: "a1", role: "ADMIN" },
        { studentId: "s1", instructorId: "i1" }
      )
    ).toBe(true);
    expect(
      canReadPrivateFile(
        { userId: "a1", role: "ADMIN" },
        { studentId: "s999", instructorId: "i999" }
      )
    ).toBe(true);
  });
});

describe("private file path: only private prefixes allowed", () => {
  const ALLOWED = ["private/receipts/", "private/submissions/"];

  function isAllowedPath(p: string): boolean {
    if (!p) return false;
    return ALLOWED.some((prefix) => p.startsWith(prefix));
  }

  it("accepts private/receipts/...", () => {
    expect(isAllowedPath("private/receipts/2026/01/abc.jpg")).toBe(true);
  });

  it("accepts private/submissions/...", () => {
    expect(isAllowedPath("private/submissions/2026/01/abc.jpg")).toBe(true);
  });

  it("rejects public/ prefix", () => {
    expect(isAllowedPath("public/foo.jpg")).toBe(false);
  });

  it("rejects attempt to access flat legacy names", () => {
    expect(isAllowedPath("receipts_2026_01_abc.jpg")).toBe(false);
  });

  it("rejects empty path", () => {
    expect(isAllowedPath("")).toBe(false);
  });
});
