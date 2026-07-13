// ====================================================================
// Taswerak — Payment webhook verification logic
//
// Pure functions extracted from /api/payments/callback/{moyasar,tap}/route.ts
// so they can be unit-tested without spinning up the full Next.js server.
// ====================================================================

import crypto from "crypto";

export interface WebhookVerificationResult {
  ok: boolean;
  reason: string;
}

/**
 * Constant-time HMAC verification.
 */
export function verifyHmac(
  received: string | undefined | null,
  secret: string,
  payload: string,
  algorithm: "sha256" | "sha512" = "sha256"
): boolean {
  if (!received || !secret) return false;
  const expected = crypto
    .createHmac(algorithm, secret)
    .update(payload)
    .digest("hex");
  try {
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Verify a Moyasar webhook signature.
 * Moyasar uses HMAC-SHA256 of the raw body with the webhook secret.
 * Returns false if the secret is not configured (fail-closed).
 */
export function verifyMoyasarWebhook(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string | undefined
): boolean {
  if (!secret) return false; // fail closed
  return verifyHmac(signatureHeader, secret, rawBody, "sha256");
}

/**
 * Verify a Tap webhook signature.
 * Tap uses HMAC-SHA256 of the raw body with the webhook secret.
 */
export function verifyTapWebhook(
  rawBody: string,
  signatureHeader: string | undefined | null,
  secret: string | undefined
): boolean {
  if (!secret) return false;
  return verifyHmac(signatureHeader, secret, rawBody, "sha256");
}

/**
 * Verify that the gateway-reported amount matches what we recorded.
 *
 * For Moyasar: amounts are in halalas (minor units). Both `expected` and
 * `received` should be in the same minor-unit scale.
 *
 * For Tap: amounts are in major currency units. Convert our stored
 * minor-units value to major before calling this.
 */
export function verifyAmount(
  expected: number,
  received: number
): boolean {
  if (!Number.isFinite(expected) || !Number.isFinite(received)) return false;
  return expected === received;
}

/**
 * Verify that the gateway-reported currency matches what we recorded.
 * Case-insensitive.
 */
export function verifyCurrency(expected: string, received: string): boolean {
  return (
    (expected || "").toUpperCase() === (received || "").toUpperCase()
  );
}

/**
 * Verify that the metadata binding on the gateway side matches the
 * local payment row. Returns false if any mismatched field is found.
 *
 * Missing fields on the gateway side are tolerated (some sandbox
 * accounts strip metadata).
 */
export function verifyPaymentMetadata(
  local: { userId: string; courseId: string },
  gateway: { userId?: string; courseId?: string }
): boolean {
  if (gateway.userId && gateway.userId !== local.userId) return false;
  if (gateway.courseId && gateway.courseId !== local.courseId) return false;
  return true;
}

/**
 * Fail-closed check: returns false if the gateway is not configured.
 */
export function isGatewayConfigured(
  gateway: "moyasar" | "tap",
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (gateway === "moyasar") return !!env.MOYASAR_SECRET_KEY;
  if (gateway === "tap") return !!env.TAP_SECRET_KEY;
  return false;
}

/**
 * Idempotency check: returns true if the payment is already PAID and
 * should not be re-processed.
 */
export function isAlreadyPaid(status: string): boolean {
  return status === "PAID";
}
