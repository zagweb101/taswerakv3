// ====================================================================
// POST /api/payments/callback/tap
// Webhook endpoint for Tap payment gateway callbacks.
//
// Production-readiness rules:
//   - FAIL CLOSED: if TAP_SECRET_KEY is not configured, return 200
//     but do NOT update any payment.
//   - Verify the Tap webhook signature using the OFFICIAL hashstring
//     method (NOT the raw JSON body). The hashstring is built from:
//       x_id, x_amount, x_currency, x_gateway_reference,
//       x_payment_reference, x_status, x_created
//     joined by "x", and signed with HMAC-SHA256 using TAP_SECRET_KEY
//     (the same key used for API auth — there is NO separate webhook
//     secret in Tap's model).
//   - The signature is sent in the `hashstring` HTTP header.
//   - Refetch the charge from Tap API; do not trust `status` alone.
//   - Verify id, amount, currency, status, userId, courseId.
//   - Idempotent: if payment.status === PAID, return without re-processing.
//   - Never activate enrollment on amount/currency mismatch.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { verifyTapWebhook, isGatewayConfigured } from "@/lib/services/webhook-verify";
import { alertWebhookSignatureFailure } from "@/lib/services/alerting";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bailOk(message: string) {
  return NextResponse.json({ ok: true, message });
}
function bailFail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function refetchTapCharge(chargeId: string) {
  const secretKey = process.env.TAP_SECRET_KEY;
  if (!secretKey) return null;
  try {
    const res = await fetch(`https://api.tap.company/v2/charges/${chargeId}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  // ---------- Fail-closed ----------
  if (!isGatewayConfigured("tap")) {
    console.warn("[tap/callback] TAP_SECRET_KEY missing — fail closed");
    await writeAudit({
      action: "WEBHOOK_REJECTED_GATEWAY_UNCONFIGURED",
      entity: "Payment",
      metadata: { gateway: "tap" },
    });
    return bailOk("Gateway not configured — acknowledged, no update");
  }
  const secretKey = process.env.TAP_SECRET_KEY!;

  // ---------- Read raw body ----------
  const rawBody = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return bailFail("Invalid JSON");
  }

  // ---------- Signature verification (official Tap hashstring method) ----------
  // Tap sends the signature in the `hashstring` header.
  // It is HMAC-SHA256 of the hashstring built from charge fields,
  // signed with TAP_SECRET_KEY (the API secret, NOT a separate webhook secret).
  const hashstringHeader =
    req.headers.get("hashstring") ||
    req.headers.get("x-callback-signature") || // legacy fallback
    undefined;
  if (!verifyTapWebhook(payload, hashstringHeader, secretKey)) {
    console.warn("[tap/callback] signature verification failed");
    await writeAudit({
      action: "WEBHOOK_REJECTED_SIGNATURE",
      entity: "Payment",
      metadata: { gateway: "tap", chargeId: payload?.id },
    });
    await alertWebhookSignatureFailure({
      gateway: "tap",
      paymentId: payload?.id,
      ip: req.headers.get("x-forwarded-for") || undefined,
    });
    return NextResponse.json(
      { ok: false, error: "Signature verification failed" },
      { status: 401 }
    );
  }

  const chargeId = payload?.id;
  if (!chargeId) return bailFail("Missing charge id");

  const payment = await db.payment.findUnique({
    where: { providerId: chargeId },
  });
  if (!payment) return bailOk("Payment not found, acknowledged");

  // ---------- Idempotency ----------
  if (payment.status === "PAID") {
    return bailOk("Already processed");
  }

  // ---------- Refetch from Tap ----------
  const verified = await refetchTapCharge(chargeId);
  if (!verified) {
    console.warn(`[tap/callback] could not refetch charge ${chargeId}`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_VERIFY_REFETCH_FAILED",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "tap", providerId: chargeId },
    });
    return NextResponse.json(
      { ok: false, error: "Could not verify with gateway" },
      { status: 502 }
    );
  }

  // ---------- Status check ----------
  if (verified.status !== "CAPTURED") {
    if (verified.status === "FAILED" || verified.status === "DECLINED" || verified.status === "VOID") {
      await db.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      await writeAudit({
        userId: payment.userId,
        action: "PAYMENT_GATEWAY_FAILED",
        entity: "Payment",
        entityId: payment.id,
        metadata: {
          gateway: "tap",
          providerId: chargeId,
          reason: verified.response?.message || verified.status,
        },
      });
    }
    return bailOk(`Status ${verified.status} — not captured`);
  }

  // ---------- Amount verification (Tap uses major currency units) ----------
  // Our Payment.amount is stored in halalas (minor units) — convert.
  const expectedMajor = Number(payment.amount) / 100;
  const gotMajor = Number(verified.amount);
  if (!Number.isFinite(gotMajor) || Math.abs(gotMajor - expectedMajor) > 0.001) {
    console.warn(
      `[tap/callback] amount mismatch: expected ${expectedMajor} got ${gotMajor}`
    );
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_AMOUNT_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: {
        gateway: "tap",
        providerId: chargeId,
        expected: expectedMajor,
        received: gotMajor,
      },
    });
    return bailOk("Amount mismatch — payment left pending for review");
  }

  // ---------- Currency ----------
  const expectedCurrency = (payment.currency || "SAR").toUpperCase();
  const gotCurrency = (verified.currency || "SAR").toUpperCase();
  if (gotCurrency !== expectedCurrency) {
    console.warn(
      `[tap/callback] currency mismatch: expected ${expectedCurrency} got ${gotCurrency}`
    );
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_CURRENCY_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: {
        gateway: "tap",
        providerId: chargeId,
        expected: expectedCurrency,
        received: gotCurrency,
      },
    });
    return bailOk("Currency mismatch — payment left pending for review");
  }

  // ---------- Metadata binding ----------
  const meta = verified.metadata || {};
  if (meta.userId && meta.userId !== payment.userId) {
    console.warn(`[tap/callback] userId mismatch`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_USER_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "tap", providerId: chargeId, expected: payment.userId, received: meta.userId },
    });
    return bailOk("User mismatch — payment left pending for review");
  }
  if (meta.courseId && meta.courseId !== payment.courseId) {
    console.warn(`[tap/callback] courseId mismatch`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_COURSE_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "tap", providerId: chargeId, expected: payment.courseId, received: meta.courseId },
    });
    return bailOk("Course mismatch — payment left pending for review");
  }

  // ---------- All checks passed ----------
  try {
    await db.$transaction([
      db.payment.update({
        where: { id: payment.id },
        data: { status: "PAID", paidAt: new Date() },
      }),
      db.enrollment.upsert({
        where: {
          studentId_courseId: {
            studentId: payment.userId,
            courseId: payment.courseId,
          },
        },
        create: {
          studentId: payment.userId,
          courseId: payment.courseId,
          status: "ACTIVE",
        },
        update: { status: "ACTIVE" },
      }),
    ]);

    await writeAudit({
      userId: payment.userId,
      action: "PAYMENT_GATEWAY_CONFIRMED",
      entity: "Payment",
      entityId: payment.id,
      metadata: {
        gateway: "tap",
        providerId: chargeId,
        amount: gotMajor,
        currency: gotCurrency,
        courseId: payment.courseId,
      },
    });
  } catch (err) {
    console.error("[tap/callback] transaction failed:", err);
    return NextResponse.json(
      { ok: false, error: "Transaction failed" },
      { status: 500 }
    );
  }

  return bailOk("Captured");
}
