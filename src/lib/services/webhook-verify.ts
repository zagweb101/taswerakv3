// ====================================================================
// Taswerak — Payment webhook verification logic
//
// Pure functions extracted from /api/payments/callback/{moyasar,tap}/route.ts
// so they can be unit-tested without spinning up the full Next.js server.
//
// References:
//   - Moyasar webhooks: https://moyasar.com/docs/api/webhooks
//     HMAC-SHA256 of the raw request body, signed with the webhook secret.
//   - Tap webhooks:     https://www.tap.company/docs/en/webhooks
//     HMAC-SHA256 of a "hashstring" built from specific charge fields,
//     signed with the TAP_SECRET_KEY (the SAME key used for API auth).
//     Tap does NOT sign the raw JSON body.
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

// ====================================================================
// Tap webhook — official hashstring verification
// ====================================================================

/**
 * Extract the fields Tap expects in the hashstring from a charge payload.
 * Returns null if any required field is missing.
 *
 * Tap's webhook payload (charge object) includes:
 *   id             — charge id (x_id)
 *   amount         — numeric, major currency (x_amount)
 *   currency       — ISO 4217, e.g. "SAR" (x_currency)
 *   gateway_reference — reference from the gateway (x_gateway_reference)
 *   reference      — { transaction: "...", order: "..." } — we use transaction (x_payment_reference)
 *   status         — "CAPTURED", "FAILED", etc. (x_status)
 *   created        — ISO timestamp (x_created)
 */
export interface TapChargeFields {
  id: string;
  amount: number | string;
  currency: string;
  gateway_reference: string;
  payment_reference: string;
  status: string;
  created: string;
}

/**
 * Parse a Tap webhook payload and extract the fields needed for the
 * hashstring. Returns null if any required field is missing.
 */
export function extractTapFields(payload: any): TapChargeFields | null {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.id;
  const amount = payload.amount;
  const currency = payload.currency;
  const gateway_reference = payload.gateway_reference;
  const payment_reference =
    typeof payload.reference === "object" && payload.reference !== null
      ? payload.reference.transaction
      : undefined;
  const status = payload.status;
  const created = payload.created;

  if (
    id == null ||
    amount == null ||
    currency == null ||
    gateway_reference == null ||
    payment_reference == null ||
    status == null ||
    created == null
  ) {
    return null;
  }
  return {
    id: String(id),
    amount: amount,
    currency: String(currency),
    gateway_reference: String(gateway_reference),
    payment_reference: String(payment_reference),
    status: String(status),
    created: String(created),
  };
}

/**
 * Format an amount for the Tap hashstring.
 *
 * Tap expects amounts to be a decimal string. For SAR (and most
 * currencies), Tap's API returns the amount as a number with up to
 * 2 decimal places. The hashstring must use the SAME representation
 * Tap used when signing — which is the raw value as it appears in the
 * JSON payload, formatted as a string with 2 decimal places.
 *
 * Per Tap's docs, the amount in the hashstring must match the amount
 * field exactly as it was sent. Since Tap always uses 2 decimal places
 * for SAR, we format to 2 decimals.
 */
export function formatTapAmount(amount: number | string): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

/**
 * Build the Tap hashstring from charge fields.
 *
 * Per Tap's official documentation, the hashstring is the concatenation
 * of these fields, separated by "x":
 *   x_id
 *   x_amount
 *   x_currency
 *   x_gateway_reference
 *   x_payment_reference
 *   x_status
 *   x_created
 *
 * The amount must be formatted to 2 decimal places.
 */
export function buildTapHashstring(fields: TapChargeFields): string {
  return [
    fields.id,
    formatTapAmount(fields.amount),
    fields.currency,
    fields.gateway_reference,
    fields.payment_reference,
    fields.status,
    fields.created,
  ].join("x");
}

/**
 * Verify a Tap webhook signature using the official hashstring method.
 *
 * Tap signs webhooks with HMAC-SHA256 of the hashstring (NOT the raw
 * body) using the TAP_SECRET_KEY — the same key used for API auth.
 * There is no separate "webhook secret" in Tap's model.
 *
 * The signature is sent in the `hashstring` header (lowercase).
 *
 * Returns false if:
 *   - TAP_SECRET_KEY is not configured (fail-closed)
 *   - The hashstring header is missing
 *   - Any required field is missing from the payload
 *   - The HMAC does not match
 */
export function verifyTapWebhook(
  payload: any,
  hashstringHeader: string | undefined | null,
  tapSecretKey: string | undefined
): boolean {
  if (!tapSecretKey) return false; // fail closed

  const fields = extractTapFields(payload);
  if (!fields) return false;

  const hashstring = buildTapHashstring(fields);
  return verifyHmac(hashstringHeader, tapSecretKey, hashstring, "sha256");
}

// ====================================================================
// Shared verification helpers
// ====================================================================

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
