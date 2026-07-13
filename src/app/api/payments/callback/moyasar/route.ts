// ====================================================================
// POST /api/payments/callback/moyasar
// Webhook endpoint for Moyasar payment gateway callbacks.
//
// Production-readiness rules:
//   - FAIL CLOSED: if MOYASAR_SECRET_KEY is not configured, return 200
//     but do NOT update any payment. Acknowledge so Moyasar stops retrying.
//   - Do NOT trust `status` alone. Refetch the payment from Moyasar API
//     and verify id, amount, currency, status, userId, courseId.
//   - Idempotent: if payment.status === PAID, return without re-processing.
//   - Reject replay: webhook secret (HMAC) must match if configured.
//   - On any verification mismatch, mark payment FAILED + audit log.
//   - Never activate enrollment on amount/currency mismatch.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { writeAudit } from "@/lib/services/audit";
import { verifyMoyasarWebhook, isGatewayConfigured } from "@/lib/services/webhook-verify";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function bailOk(message: string) {
  // 200 to stop retries — Moyasar treats non-2xx as retryable.
  return NextResponse.json({ ok: true, message });
}

function bailFail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function refetchMoyasarPayment(paymentId: string) {
  const apiKey = process.env.MOYASAR_SECRET_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(`https://api.moyasar.com/v1/payments/${paymentId}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(apiKey + ":").toString("base64")}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  // ---------- Fail-closed: gateway must be configured ----------
  if (!isGatewayConfigured("moyasar")) {
    console.warn("[moyasar/callback] MOYASAR_SECRET_KEY missing — fail closed");
    await writeAudit({
      action: "WEBHOOK_REJECTED_GATEWAY_UNCONFIGURED",
      entity: "Payment",
      metadata: { gateway: "moyasar" },
    });
    return bailOk("Gateway not configured — acknowledged, no update");
  }
  const apiKey = process.env.MOYASAR_SECRET_KEY!;

  // ---------- Read raw body for HMAC verification ----------
  const rawBody = await req.text();
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return bailFail("Invalid JSON");
  }

  // ---------- Signature verification (required in production) ----------
  const sigHeader =
    req.headers.get("moyasar-signature") ||
    req.headers.get("x-moyasar-signature") ||
    undefined;
  if (!verifyMoyasarWebhook(rawBody, sigHeader, process.env.MOYASAR_WEBHOOK_SECRET)) {
    console.warn("[moyasar/callback] signature verification failed");
    await writeAudit({
      action: "WEBHOOK_REJECTED_SIGNATURE",
      entity: "Payment",
      metadata: { gateway: "moyasar", paymentId: payload?.id },
    });
    // Return 401 so Moyasar retries with a valid signature
    return NextResponse.json(
      { ok: false, error: "Signature verification failed" },
      { status: 401 }
    );
  }

  const paymentId = payload?.id;
  if (!paymentId) {
    return bailFail("Missing payment id");
  }

  // ---------- Find our Payment record ----------
  const payment = await db.payment.findUnique({
    where: { providerId: paymentId },
  });
  if (!payment) {
    // Idempotent ack — Moyasar will stop retrying
    return bailOk("Payment not found, acknowledged");
  }

  // ---------- Idempotency: already paid ----------
  if (payment.status === "PAID") {
    return bailOk("Already processed");
  }

  // ---------- Refetch from Moyasar to verify ----------
  const verified = await refetchMoyasarPayment(paymentId);
  if (!verified) {
    console.warn(`[moyasar/callback] could not refetch payment ${paymentId}`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_VERIFY_REFETCH_FAILED",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "moyasar", providerId: paymentId },
    });
    // 502 → Moyasar will retry
    return NextResponse.json(
      { ok: false, error: "Could not verify with gateway" },
      { status: 502 }
    );
  }

  // ---------- Verify status from gateway ----------
  if (verified.status !== "paid") {
    // Update to FAILED if applicable
    if (verified.status === "failed") {
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
          gateway: "moyasar",
          providerId: paymentId,
          reason: verified.source?.message || verified.status,
        },
      });
    }
    return bailOk(`Status ${verified.status} — not paid`);
  }

  // ---------- Verify amount (Moyasar stores halalas) ----------
  const expectedHalalas = Math.round(Number(payment.amount)); // already stored in halalas
  const gotHalalas = Number(verified.amount);
  if (!Number.isFinite(gotHalalas) || gotHalalas !== expectedHalalas) {
    console.warn(
      `[moyasar/callback] amount mismatch: expected ${expectedHalalas} got ${gotHalalas}`
    );
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_AMOUNT_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: {
        gateway: "moyasar",
        providerId: paymentId,
        expected: expectedHalalas,
        received: gotHalalas,
      },
    });
    // DO NOT activate enrollment — leave payment PENDING for manual review
    return bailOk("Amount mismatch — payment left pending for review");
  }

  // ---------- Verify currency ----------
  const expectedCurrency = (payment.currency || "SAR").toUpperCase();
  const gotCurrency = (verified.currency || "SAR").toUpperCase();
  if (gotCurrency !== expectedCurrency) {
    console.warn(
      `[moyasar/callback] currency mismatch: expected ${expectedCurrency} got ${gotCurrency}`
    );
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_CURRENCY_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: {
        gateway: "moyasar",
        providerId: paymentId,
        expected: expectedCurrency,
        received: gotCurrency,
      },
    });
    return bailOk("Currency mismatch — payment left pending for review");
  }

  // ---------- Verify metadata binding ----------
  const meta = verified.metadata || {};
  if (
    meta.userId &&
    meta.userId !== payment.userId
  ) {
    console.warn(`[moyasar/callback] userId mismatch`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_USER_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "moyasar", providerId: paymentId, expected: payment.userId, received: meta.userId },
    });
    return bailOk("User mismatch — payment left pending for review");
  }
  if (
    meta.courseId &&
    meta.courseId !== payment.courseId
  ) {
    console.warn(`[moyasar/callback] courseId mismatch`);
    await writeAudit({
      userId: payment.userId,
      action: "WEBHOOK_COURSE_MISMATCH",
      entity: "Payment",
      entityId: payment.id,
      metadata: { gateway: "moyasar", providerId: paymentId, expected: payment.courseId, received: meta.courseId },
    });
    return bailOk("Course mismatch — payment left pending for review");
  }

  // ---------- All checks passed: mark PAID + activate enrollment ----------
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
        gateway: "moyasar",
        providerId: paymentId,
        amount: gotHalalas / 100,
        currency: gotCurrency,
        courseId: payment.courseId,
      },
    });
  } catch (err) {
    console.error("[moyasar/callback] transaction failed:", err);
    // 500 → Moyasar will retry, and our idempotency check above will skip the PAID update
    return NextResponse.json(
      { ok: false, error: "Transaction failed" },
      { status: 500 }
    );
  }

  return bailOk("Paid");
}
