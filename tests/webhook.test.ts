// ====================================================================
// Payment webhook verification tests
// ====================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  verifyHmac,
  verifyMoyasarWebhook,
  verifyTapWebhook,
  extractTapFields,
  buildTapHashstring,
  formatTapAmount,
  verifyAmount,
  verifyCurrency,
  verifyPaymentMetadata,
  isGatewayConfigured,
  isAlreadyPaid,
} from "@/lib/services/webhook-verify";

describe("webhook: HMAC verification", () => {
  const secret = "test-secret-32chars-long-aaaaaaaa";
  const body = JSON.stringify({
    id: "pay_123",
    status: "paid",
    amount: 89900,
    currency: "SAR",
  });

  it("accepts a valid HMAC signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmac(sig, secret, body, "sha256")).toBe(true);
  });

  it("rejects an invalid HMAC signature", () => {
    expect(verifyHmac("deadbeef", secret, body, "sha256")).toBe(false);
  });

  it("rejects when signature is missing", () => {
    expect(verifyHmac(undefined, secret, body, "sha256")).toBe(false);
    expect(verifyHmac(null, secret, body, "sha256")).toBe(false);
    expect(verifyHmac("", secret, body, "sha256")).toBe(false);
  });

  it("rejects when secret is missing (fail closed)", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyHmac(sig, "", body, "sha256")).toBe(false);
    expect(verifyHmac(sig, undefined as any, body, "sha256")).toBe(false);
  });

  it("is constant-time — same-length signatures still reject", () => {
    // Different content but same length
    const sig1 = crypto.createHmac("sha256", secret).update(body).digest("hex");
    const sig2 = "a".repeat(sig1.length);
    expect(verifyHmac(sig2, secret, body, "sha256")).toBe(false);
  });
});

describe("webhook: Moyasar signature verification", () => {
  const secret = "moyasar-wh-secret-32-chars-long";
  const body = '{"id":"pay_1","status":"paid"}';

  it("accepts a valid Moyasar signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMoyasarWebhook(body, sig, secret)).toBe(true);
  });

  it("rejects when no secret configured (fail closed)", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyMoyasarWebhook(body, sig, undefined)).toBe(false);
  });

  it("rejects unsigned webhooks", () => {
    expect(verifyMoyasarWebhook(body, undefined, secret)).toBe(false);
    expect(verifyMoyasarWebhook(body, "", secret)).toBe(false);
  });
});

// ====================================================================
// Tap webhook — official hashstring verification tests
// Per https://www.tap.company/docs/en/webhooks
// ====================================================================

// Realistic Tap charge payload fixture (shape matches Tap's webhook docs)
const tapChargeFixture = {
  id: "chg_TS01A3BCDEFG",
  amount: 100.00,
  currency: "SAR",
  gateway_reference: "87654321",
  reference: {
    transaction: "txn_2024ABCDE",
    order: "ord_2024XYZ",
  },
  status: "CAPTURED",
  created: "2024-12-15T10:30:00.000Z",
};

describe("webhook: Tap hashstring construction", () => {
  it("formats SAR amount to 2 decimal places", () => {
    expect(formatTapAmount(100)).toBe("100.00");
    expect(formatTapAmount(100.0)).toBe("100.00");
    expect(formatTapAmount(100.5)).toBe("100.50");
    expect(formatTapAmount("100.25")).toBe("100.25");
  });

  it("handles zero amount", () => {
    expect(formatTapAmount(0)).toBe("0.00");
  });

  it("rejects non-finite amounts", () => {
    expect(formatTapAmount(NaN)).toBe("0.00");
    expect(formatTapAmount(Infinity)).toBe("0.00");
    expect(formatTapAmount("abc")).toBe("0.00");
  });

  it("builds the correct hashstring from charge fields", () => {
    const fields = extractTapFields(tapChargeFixture)!;
    const hashstring = buildTapHashstring(fields);
    // x_id x x_amount x x_currency x x_gateway_reference x x_payment_reference x x_status x x_created
    expect(hashstring).toBe(
      "chg_TS01A3BCDEFGx100.00xSARx87654321xtxn_2024ABCDExCAPTUREDx2024-12-15T10:30:00.000Z"
    );
  });
});

describe("webhook: Tap field extraction", () => {
  it("extracts all required fields from a Tap charge payload", () => {
    const fields = extractTapFields(tapChargeFixture);
    expect(fields).not.toBeNull();
    expect(fields!.id).toBe("chg_TS01A3BCDEFG");
    expect(fields!.amount).toBe(100.00);
    expect(fields!.currency).toBe("SAR");
    expect(fields!.gateway_reference).toBe("87654321");
    expect(fields!.payment_reference).toBe("txn_2024ABCDE");
    expect(fields!.status).toBe("CAPTURED");
    expect(fields!.created).toBe("2024-12-15T10:30:00.000Z");
  });

  it("returns null if any required field is missing", () => {
    expect(extractTapFields({ id: "x" })).toBeNull();
    expect(extractTapFields({ ...tapChargeFixture, id: null })).toBeNull();
    expect(extractTapFields({ ...tapChargeFixture, amount: undefined })).toBeNull();
    expect(extractTapFields({ ...tapChargeFixture, reference: {} })).toBeNull();
    expect(extractTapFields(null)).toBeNull();
    expect(extractTapFields("string")).toBeNull();
  });

  it("extracts payment_reference from reference.transaction", () => {
    const fields = extractTapFields({
      ...tapChargeFixture,
      reference: { transaction: "pay_ref_xyz" },
    });
    expect(fields!.payment_reference).toBe("pay_ref_xyz");
  });
});

describe("webhook: Tap signature verification (hashstring method)", () => {
  const tapSecretKey = "sk_test_XXXXXXXXXXXXXXXXXXXXXX"; // TAP_SECRET_KEY

  it("accepts a valid Tap hashstring signature", () => {
    const fields = extractTapFields(tapChargeFixture)!;
    const hashstring = buildTapHashstring(fields);
    const sig = crypto.createHmac("sha256", tapSecretKey).update(hashstring).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, sig, tapSecretKey)).toBe(true);
  });

  it("rejects when TAP_SECRET_KEY is not configured (fail closed)", () => {
    const fields = extractTapFields(tapChargeFixture)!;
    const hashstring = buildTapHashstring(fields);
    const sig = crypto.createHmac("sha256", tapSecretKey).update(hashstring).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, sig, undefined)).toBe(false);
    expect(verifyTapWebhook(tapChargeFixture, sig, "")).toBe(false);
  });

  it("rejects when hashstring header is missing", () => {
    expect(verifyTapWebhook(tapChargeFixture, undefined, tapSecretKey)).toBe(false);
    expect(verifyTapWebhook(tapChargeFixture, "", tapSecretKey)).toBe(false);
  });

  it("rejects a signature computed from the raw JSON body (NOT hashstring)", () => {
    // Attacker signs the raw body instead of the hashstring
    const rawBody = JSON.stringify(tapChargeFixture);
    const wrongSig = crypto.createHmac("sha256", tapSecretKey).update(rawBody).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, wrongSig, tapSecretKey)).toBe(false);
  });

  it("rejects a signature with wrong amount precision", () => {
    // Attacker uses "100" instead of "100.00"
    const fields = extractTapFields(tapChargeFixture)!;
    const wrongHashstring = [
      fields.id,
      "100", // wrong precision
      fields.currency,
      fields.gateway_reference,
      fields.payment_reference,
      fields.status,
      fields.created,
    ].join("x");
    const wrongSig = crypto.createHmac("sha256", tapSecretKey).update(wrongHashstring).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, wrongSig, tapSecretKey)).toBe(false);
  });

  it("rejects a signature with tampered status", () => {
    const fields = extractTapFields(tapChargeFixture)!;
    const tamperedHashstring = buildTapHashstring({ ...fields, status: "FAILED" });
    const tamperedSig = crypto.createHmac("sha256", tapSecretKey).update(tamperedHashstring).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, tamperedSig, tapSecretKey)).toBe(false);
  });

  it("rejects when payload is missing required fields", () => {
    const incompletePayload = { id: "chg_1", status: "CAPTURED" }; // missing amount, currency, etc.
    const sig = crypto.createHmac("sha256", tapSecretKey).update("x").digest("hex");
    expect(verifyTapWebhook(incompletePayload, sig, tapSecretKey)).toBe(false);
  });

  it("uses the SAME key for API auth and webhook verification", () => {
    // Per Tap docs, there is no separate webhook secret — TAP_SECRET_KEY
    // is used for both. This test documents that contract.
    const fields = extractTapFields(tapChargeFixture)!;
    const hashstring = buildTapHashstring(fields);
    const sig = crypto.createHmac("sha256", tapSecretKey).update(hashstring).digest("hex");
    expect(verifyTapWebhook(tapChargeFixture, sig, tapSecretKey)).toBe(true);
    // A different key should fail
    const differentKey = "sk_live_YYYYYYYYYYYYYYYYYYYY";
    expect(verifyTapWebhook(tapChargeFixture, sig, differentKey)).toBe(false);
  });
});

describe("webhook: amount verification", () => {
  it("accepts matching amounts", () => {
    expect(verifyAmount(89900, 89900)).toBe(true);
  });

  it("rejects mismatched amounts", () => {
    expect(verifyAmount(89900, 89999)).toBe(false);
    expect(verifyAmount(89900, 0)).toBe(false);
  });

  it("rejects NaN/Infinity", () => {
    expect(verifyAmount(NaN, 89900)).toBe(false);
    expect(verifyAmount(89900, Infinity)).toBe(false);
  });
});

describe("webhook: currency verification", () => {
  it("accepts matching currency (case-insensitive)", () => {
    expect(verifyCurrency("SAR", "SAR")).toBe(true);
    expect(verifyCurrency("sar", "SAR")).toBe(true);
    expect(verifyCurrency("SAR", "sar")).toBe(true);
  });

  it("rejects mismatched currency", () => {
    expect(verifyCurrency("SAR", "USD")).toBe(false);
    expect(verifyCurrency("SAR", "")).toBe(false);
  });
});

describe("webhook: metadata binding", () => {
  it("accepts matching userId + courseId", () => {
    expect(
      verifyPaymentMetadata(
        { userId: "u1", courseId: "c1" },
        { userId: "u1", courseId: "c1" }
      )
    ).toBe(true);
  });

  it("accepts when gateway omits metadata fields", () => {
    expect(
      verifyPaymentMetadata(
        { userId: "u1", courseId: "c1" },
        {}
      )
    ).toBe(true);
  });

  it("rejects userId mismatch", () => {
    expect(
      verifyPaymentMetadata(
        { userId: "u1", courseId: "c1" },
        { userId: "u2", courseId: "c1" }
      )
    ).toBe(false);
  });

  it("rejects courseId mismatch", () => {
    expect(
      verifyPaymentMetadata(
        { userId: "u1", courseId: "c1" },
        { userId: "u1", courseId: "c2" }
      )
    ).toBe(false);
  });
});

describe("webhook: gateway configuration check", () => {
  beforeEach(() => {
    vi.stubEnv("MOYASAR_SECRET_KEY", "");
    vi.stubEnv("TAP_SECRET_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns false when MOYASAR_SECRET_KEY missing", () => {
    expect(isGatewayConfigured("moyasar")).toBe(false);
  });

  it("returns true when MOYASAR_SECRET_KEY set", () => {
    vi.stubEnv("MOYASAR_SECRET_KEY", "sk_test_xxx");
    expect(isGatewayConfigured("moyasar")).toBe(true);
  });

  it("returns false when TAP_SECRET_KEY missing", () => {
    expect(isGatewayConfigured("tap")).toBe(false);
  });

  it("returns true when TAP_SECRET_KEY set", () => {
    vi.stubEnv("TAP_SECRET_KEY", "sk_test_xxx");
    expect(isGatewayConfigured("tap")).toBe(true);
  });
});

describe("webhook: idempotency", () => {
  it("treats PAID as already-processed", () => {
    expect(isAlreadyPaid("PAID")).toBe(true);
  });

  it("treats PENDING / FAILED as not-paid", () => {
    expect(isAlreadyPaid("PENDING")).toBe(false);
    expect(isAlreadyPaid("FAILED")).toBe(false);
    expect(isAlreadyPaid("")).toBe(false);
  });
});
