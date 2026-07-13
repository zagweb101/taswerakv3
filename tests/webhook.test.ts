// ====================================================================
// Payment webhook verification tests
// ====================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import {
  verifyHmac,
  verifyMoyasarWebhook,
  verifyTapWebhook,
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

describe("webhook: Tap signature verification", () => {
  const secret = "tap-wh-secret-32-chars-long";
  const body = '{"id":"chg_1","status":"CAPTURED"}';

  it("accepts a valid Tap signature", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyTapWebhook(body, sig, secret)).toBe(true);
  });

  it("rejects when no secret configured", () => {
    const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyTapWebhook(body, sig, undefined)).toBe(false);
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
