// ====================================================================
// Integration tests — Payment flow business logic
//
// These tests verify the END-TO-END payment receipt logic using
// pure-function re-implementations of the route's business rules.
// They don't require a database — they test the LOGIC that the
// route implements.
// ====================================================================

import { describe, it, expect } from "vitest";

// ====================================================================
// Re-implementations of the route's business logic for testing
// ====================================================================

interface Course {
  price: number | null;
  discountPrice: number | null;
  isFree: boolean;
  status: string;
  currency: string;
}

interface PaymentInput {
  courseId: string;
  amount: number; // student-declared
  bankName: string;
}

interface PaymentResult {
  ok: boolean;
  error?: string;
  status: number;
  expectedAmount?: number;
  declaredTransferredAmount?: number;
  shouldCreateReceipt?: boolean;
}

/**
 * Simulates the student/payments POST route logic.
 */
function processPaymentUpload(
  course: Course | null,
  input: PaymentInput,
  existingEnrollment: { status: string } | null
): PaymentResult {
  // 1. Course exists?
  if (!course) return { ok: false, error: "الدورة غير موجودة", status: 404 };

  // 2. Course published?
  if (course.status !== "PUBLISHED")
    return { ok: false, error: "الدورة غير متاحة للتسجيل", status: 400 };

  // 3. Compute expectedAmount (server-side, from course.price or discountPrice)
  const regularPrice = course.price ? Number(course.price) : 0;
  const discountPrice = course.discountPrice ? Number(course.discountPrice) : null;
  const hasValidDiscount =
    discountPrice !== null && discountPrice > 0 && discountPrice < regularPrice;
  const expectedAmount = hasValidDiscount ? discountPrice! : regularPrice;

  // 4. Free course check
  if (course.isFree || expectedAmount === 0)
    return { ok: false, error: "هذه الدورة مجانية ولا تتطلب إيصال تحويل", status: 400 };

  // 5. Duplicate enrollment check
  if (existingEnrollment && ["ACTIVE", "PENDING_APPROVAL"].includes(existingEnrollment.status))
    return { ok: false, error: "أنت مسجّل في هذه الدورة بالفعل", status: 409 };

  // 6. Amount validation (positive finite number)
  if (!Number.isFinite(input.amount) || input.amount <= 0)
    return { ok: false, error: "المبلغ يجب أن يكون رقمًا موجبًا صالحًا", status: 400 };

  // 7. Bank name required
  if (!input.bankName || input.bankName.length < 2)
    return { ok: false, error: "اسم البنك مطلوب", status: 400 };

  return {
    ok: true,
    status: 200,
    expectedAmount,
    declaredTransferredAmount: input.amount,
    shouldCreateReceipt: true,
  };
}

/**
 * Simulates the instructor/payments PATCH route logic (approve/reject).
 */
function processPaymentApproval(
  receipt: {
    amount: number; // expectedAmount (official)
    declaredTransferredAmount: number | null;
    currency: string;
    status: string;
  },
  action: "APPROVE" | "REJECT",
  allowPartialPayment: boolean
): { ok: boolean; error?: string; status: number } {
  if (receipt.status !== "PENDING")
    return { ok: false, error: "تمت مراجعة هذا الإيصال مسبقاً", status: 409 };

  if (action === "APPROVE") {
    const expectedAmount = Number(receipt.amount);
    const declaredAmount = receipt.declaredTransferredAmount
      ? Number(receipt.declaredTransferredAmount)
      : null;

    if (declaredAmount !== null && declaredAmount !== expectedAmount && !allowPartialPayment) {
      return {
        ok: false,
        error: `المبلغ المعلن (${declaredAmount}) لا يطابق المبلغ المطلوب (${expectedAmount})`,
        status: 409,
      };
    }
    return { ok: true, status: 200 };
  }

  return { ok: true, status: 200 };
}

// ====================================================================
// Tests
// ====================================================================

describe("payment flow: upload receipt", () => {
  const validCourse: Course = {
    price: 1000,
    discountPrice: null,
    isFree: false,
    status: "PUBLISHED",
    currency: "SAR",
  };

  it("accepts a valid payment upload", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 1000,
      bankName: "البنك الأهلي",
    }, null);
    expect(result.ok).toBe(true);
    expect(result.expectedAmount).toBe(1000);
    expect(result.declaredTransferredAmount).toBe(1000);
    expect(result.shouldCreateReceipt).toBe(true);
  });

  it("rejects when course doesn't exist", () => {
    const result = processPaymentUpload(null, {
      courseId: "x",
      amount: 1000,
      bankName: "بنك",
    }, null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
  });

  it("rejects unpublished course", () => {
    const result = processPaymentUpload(
      { ...validCourse, status: "DRAFT" },
      { courseId: "c1", amount: 1000, bankName: "بنك" },
      null
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects free course", () => {
    const result = processPaymentUpload(
      { ...validCourse, isFree: true },
      { courseId: "c1", amount: 0, bankName: "بنك" },
      null
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects duplicate enrollment (ACTIVE)", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 1000,
      bankName: "بنك",
    }, { status: "ACTIVE" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("rejects duplicate enrollment (PENDING_APPROVAL)", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 1000,
      bankName: "بنك",
    }, { status: "PENDING_APPROVAL" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("allows re-enrollment after CANCELLED", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 1000,
      bankName: "بنك",
    }, { status: "CANCELLED" });
    expect(result.ok).toBe(true);
  });

  it("uses discountPrice when valid", () => {
    const result = processPaymentUpload(
      { ...validCourse, price: 1000, discountPrice: 800 },
      { courseId: "c1", amount: 800, bankName: "بنك" },
      null
    );
    expect(result.ok).toBe(true);
    expect(result.expectedAmount).toBe(800);
  });

  it("uses regular price when discountPrice is invalid (>= regular)", () => {
    const result = processPaymentUpload(
      { ...validCourse, price: 1000, discountPrice: 1200 },
      { courseId: "c1", amount: 1000, bankName: "بنك" },
      null
    );
    expect(result.expectedAmount).toBe(1000);
  });

  it("Scenario: price=1000, discount=800, student sends amount=1", () => {
    const result = processPaymentUpload(
      { ...validCourse, price: 1000, discountPrice: 800 },
      { courseId: "c1", amount: 1, bankName: "بنك" },
      null
    );
    expect(result.ok).toBe(true);
    expect(result.expectedAmount).toBe(800); // server-computed, NOT student's 1
    expect(result.declaredTransferredAmount).toBe(1); // student's declared
    expect(result.expectedAmount).not.toBe(result.declaredTransferredAmount);
  });

  it("rejects negative amount", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: -100,
      bankName: "بنك",
    }, null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects zero amount", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 0,
      bankName: "بنك",
    }, null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });

  it("rejects missing bank name", () => {
    const result = processPaymentUpload(validCourse, {
      courseId: "c1",
      amount: 1000,
      bankName: "",
    }, null);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
  });
});

describe("payment flow: approve/reject receipt", () => {
  const validReceipt = {
    amount: 1000, // expectedAmount (official)
    declaredTransferredAmount: 1000,
    currency: "SAR",
    status: "PENDING",
  };

  it("approves when amounts match", () => {
    const result = processPaymentApproval(validReceipt, "APPROVE", false);
    expect(result.ok).toBe(true);
  });

  it("rejects approval when amounts differ and no partial flag", () => {
    const result = processPaymentApproval(
      { ...validReceipt, declaredTransferredAmount: 1 },
      "APPROVE",
      false
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("allows approval when amounts differ WITH partial flag", () => {
    const result = processPaymentApproval(
      { ...validReceipt, declaredTransferredAmount: 1 },
      "APPROVE",
      true
    );
    expect(result.ok).toBe(true);
  });

  it("rejects approval of already-reviewed receipt", () => {
    const result = processPaymentApproval(
      { ...validReceipt, status: "APPROVED" },
      "APPROVE",
      false
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(409);
  });

  it("allows rejection regardless of amount mismatch", () => {
    const result = processPaymentApproval(
      { ...validReceipt, declaredTransferredAmount: 1 },
      "REJECT",
      false
    );
    expect(result.ok).toBe(true);
  });

  it("approves when declaredTransferredAmount is null (legacy receipt)", () => {
    const result = processPaymentApproval(
      { ...validReceipt, declaredTransferredAmount: null },
      "APPROVE",
      false
    );
    expect(result.ok).toBe(true);
  });
});

// ====================================================================
// Full payment lifecycle test
// ====================================================================

describe("payment flow: full lifecycle", () => {
  it("Scenario: course 1000 SAR, student uploads with amount=1, instructor rejects, student retries with 1000, instructor approves", () => {
    const course: Course = {
      price: 1000,
      discountPrice: null,
      isFree: false,
      status: "PUBLISHED",
      currency: "SAR",
    };

    // Step 1: Student uploads with wrong amount (1 instead of 1000)
    const upload1 = processPaymentUpload(course, {
      courseId: "c1",
      amount: 1,
      bankName: "البنك الأهلي",
    }, null);
    expect(upload1.ok).toBe(true);
    expect(upload1.expectedAmount).toBe(1000);
    expect(upload1.declaredTransferredAmount).toBe(1);

    // Step 2: Instructor tries to approve — should be blocked
    const approve1 = processPaymentApproval({
      amount: 1000,
      declaredTransferredAmount: 1,
      currency: "SAR",
      status: "PENDING",
    }, "APPROVE", false);
    expect(approve1.ok).toBe(false);
    expect(approve1.status).toBe(409);

    // Step 3: Instructor rejects instead
    const reject = processPaymentApproval({
      amount: 1000,
      declaredTransferredAmount: 1,
      currency: "SAR",
      status: "PENDING",
    }, "REJECT", false);
    expect(reject.ok).toBe(true);

    // Step 4: Student retries with correct amount
    const upload2 = processPaymentUpload(course, {
      courseId: "c1",
      amount: 1000,
      bankName: "البنك الأهلي",
    }, { status: "CANCELLED" }); // previous enrollment was cancelled
    expect(upload2.ok).toBe(true);
    expect(upload2.expectedAmount).toBe(1000);
    expect(upload2.declaredTransferredAmount).toBe(1000);

    // Step 5: Instructor approves — should succeed
    const approve2 = processPaymentApproval({
      amount: 1000,
      declaredTransferredAmount: 1000,
      currency: "SAR",
      status: "PENDING",
    }, "APPROVE", false);
    expect(approve2.ok).toBe(true);
  });
});
