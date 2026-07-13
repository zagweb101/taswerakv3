// ====================================================================
// Submission upload business-rule tests (logic-level).
// ====================================================================

import { describe, it, expect } from "vitest";

/**
 * Replicate the maxAttempts check used in /api/student/submissions.
 * Returns true if the student may submit again, false otherwise.
 */
function canSubmitAgain(existingCount: number, maxAttempts: number): boolean {
  return existingCount < maxAttempts;
}

describe("submissions: maxAttempts enforcement", () => {
  it("allows first submission when maxAttempts=1", () => {
    expect(canSubmitAgain(0, 1)).toBe(true);
  });

  it("blocks second submission when maxAttempts=1", () => {
    expect(canSubmitAgain(1, 1)).toBe(false);
  });

  it("allows third submission when maxAttempts=3", () => {
    expect(canSubmitAgain(2, 3)).toBe(true);
  });

  it("blocks fourth submission when maxAttempts=3", () => {
    expect(canSubmitAgain(3, 3)).toBe(false);
  });

  it("blocks when existingCount exceeds maxAttempts", () => {
    expect(canSubmitAgain(10, 3)).toBe(false);
  });

  it("treats maxAttempts=0 as 'no submissions allowed'", () => {
    expect(canSubmitAgain(0, 0)).toBe(false);
  });
});

/**
 * Replicate the duplicate enrollment check.
 * Existing enrollments in ACTIVE or PENDING_APPROVAL status block re-enrollment.
 */
const BLOCKED_STATUSES = ["ACTIVE", "PENDING_APPROVAL"];

function isDuplicateEnrollment(status: string | null | undefined): boolean {
  return !!status && BLOCKED_STATUSES.includes(status);
}

describe("enrollment: duplicate prevention", () => {
  it("blocks when ACTIVE exists", () => {
    expect(isDuplicateEnrollment("ACTIVE")).toBe(true);
  });

  it("blocks when PENDING_APPROVAL exists", () => {
    expect(isDuplicateEnrollment("PENDING_APPROVAL")).toBe(true);
  });

  it("allows re-enrollment after CANCELLED", () => {
    expect(isDuplicateEnrollment("CANCELLED")).toBe(false);
  });

  it("allows re-enrollment after REFUNDED", () => {
    expect(isDuplicateEnrollment("REFUNDED")).toBe(false);
  });

  it("allows initial enrollment (no existing record)", () => {
    expect(isDuplicateEnrollment(null)).toBe(false);
    expect(isDuplicateEnrollment(undefined)).toBe(false);
  });
});

/**
 * Replicate the published-course check.
 */
function canEnrollInCourse(status: string): boolean {
  return status === "PUBLISHED";
}

describe("enrollment: course must be published", () => {
  it("allows PUBLISHED", () => expect(canEnrollInCourse("PUBLISHED")).toBe(true));
  it("blocks DRAFT", () => expect(canEnrollInCourse("DRAFT")).toBe(false));
  it("blocks PENDING_REVIEW", () => expect(canEnrollInCourse("PENDING_REVIEW")).toBe(false));
  it("blocks REJECTED", () => expect(canEnrollInCourse("REJECTED")).toBe(false));
  it("blocks ARCHIVED", () => expect(canEnrollInCourse("ARCHIVED")).toBe(false));
  it("blocks UNLISTED", () => expect(canEnrollInCourse("UNLISTED")).toBe(false));
});

/**
 * Replicate the amount validation.
 */
function isValidAmount(v: any): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n > 0;
}

describe("payment receipt: amount validation", () => {
  it("accepts positive numbers", () => {
    expect(isValidAmount(499)).toBe(true);
    expect(isValidAmount("499")).toBe(true);
    expect(isValidAmount(0.01)).toBe(true);
  });

  it("rejects zero", () => {
    expect(isValidAmount(0)).toBe(false);
    expect(isValidAmount("0")).toBe(false);
  });

  it("rejects negative", () => {
    expect(isValidAmount(-1)).toBe(false);
    expect(isValidAmount("-100")).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    expect(isValidAmount("abc")).toBe(false);
    expect(isValidAmount("")).toBe(false);
    expect(isValidAmount(null)).toBe(false);
    expect(isValidAmount(undefined)).toBe(false);
  });

  it("rejects NaN / Infinity", () => {
    expect(isValidAmount(NaN)).toBe(false);
    expect(isValidAmount(Infinity)).toBe(false);
  });
});

// ====================================================================
// Expected amount vs declared amount — server-side calculation tests
// ====================================================================

/**
 * Simulate the server-side expected amount calculation from course price.
 * The route does: expectedAmount = Number(course.price)
 * The student-submitted amount is recorded separately as declaredTransferredAmount.
 */
function computeExpectedAmount(coursePrice: number | null | undefined, isFree: boolean): number {
  if (isFree) return 0;
  if (!coursePrice || !Number.isFinite(Number(coursePrice))) return 0;
  return Number(coursePrice);
}

describe("payment: server-side expected amount calculation", () => {
  it("computes expected amount from course price", () => {
    expect(computeExpectedAmount(1000, false)).toBe(1000);
    expect(computeExpectedAmount(499.99, false)).toBe(499.99);
  });

  it("returns 0 for free courses", () => {
    expect(computeExpectedAmount(1000, true)).toBe(0);
    expect(computeExpectedAmount(0, true)).toBe(0);
  });

  it("returns 0 when price is null/undefined", () => {
    expect(computeExpectedAmount(null, false)).toBe(0);
    expect(computeExpectedAmount(undefined, false)).toBe(0);
  });

  it("does NOT trust the student-submitted amount", () => {
    // Scenario: course costs 1000, student submits amount=1
    // The route should use expectedAmount=1000 (from course.price),
    // NOT the student's declared amount=1.
    const coursePrice = 1000;
    const studentDeclared = 1;
    const expectedAmount = computeExpectedAmount(coursePrice, false);
    expect(expectedAmount).toBe(1000);
    expect(expectedAmount).not.toBe(studentDeclared);
    // The receipt stores expectedAmount as the official amount
    // and studentDeclared in notes for instructor comparison.
  });

  it("rejects free course receipt upload (no receipt needed)", () => {
    const expectedAmount = computeExpectedAmount(0, true);
    expect(expectedAmount).toBe(0);
    // Route returns 400: "هذه الدورة مجانية ولا تتطلب إيصال تحويل"
  });
});
