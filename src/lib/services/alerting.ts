// ====================================================================
// Taswerak — Alerting service
//
// Sends alerts to Slack (via webhook) and/or WhatsApp (via Whapi.cloud)
// when critical business events occur:
//   - Payment failure
//   - Health check degradation
//   - Rate limit abuse (sustained)
//   - Storage quota warning
//   - Webhook signature verification failure
//
// Configuration (all optional — if not set, alerts are logged only):
//   SLACK_WEBHOOK_URL — Slack incoming webhook URL
//   ALERT_WHATSAPP_NUMBER — phone number for WhatsApp alerts (Whapi)
//   WHAPI_API_KEY — Whapi.cloud API key
//
// Usage:
//   import { alertPaymentFailure, alertHealthDegraded } from "@/lib/services/alerting";
//   await alertPaymentFailure({ amount, currency, studentEmail, reason });
// ====================================================================

import { sendWhatsAppNotification } from "@/lib/services/whatsapp";

type AlertLevel = "critical" | "warning" | "info";

interface AlertPayload {
  level: AlertLevel;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const ALERT_WHATSAPP_NUMBER = process.env.ALERT_WHATSAPP_NUMBER;

const LEVEL_EMOJI: Record<AlertLevel, string> = {
  critical: "🔴",
  warning: "🟡",
  info: "🔵",
};

const LEVEL_COLOR: Record<AlertLevel, string> = {
  critical: "#ff0000",
  warning: "#ffaa00",
  info: "#0099ff",
};

/**
 * Send an alert to all configured channels (Slack + WhatsApp).
 * If neither is configured, logs to console.
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const { level, title, message, metadata } = payload;
  const emoji = LEVEL_EMOJI[level];
  const timestamp = new Date().toISOString();

  // Always log to console
  console.warn(`[alert] ${emoji} ${title}: ${message}`, metadata || "");

  // Send to Slack
  if (SLACK_WEBHOOK_URL) {
    try {
      await sendSlackAlert(payload, timestamp);
    } catch (err) {
      console.error("[alert] Slack send failed:", err);
    }
  }

  // Send to WhatsApp
  if (ALERT_WHATSAPP_NUMBER && process.env.WHAPI_API_KEY) {
    try {
      await sendWhatsAppAlert(payload, timestamp);
    } catch (err) {
      console.error("[alert] WhatsApp send failed:", err);
    }
  }
}

async function sendSlackAlert(payload: AlertPayload, timestamp: string): Promise<void> {
  const { level, title, message, metadata } = payload;
  const color = LEVEL_COLOR[level];
  const emoji = LEVEL_EMOJI[level];

  const text = `${emoji} *${title}*\n${message}`;
  const fields: Array<{ title: string; value: string; short: boolean }> = [];
  if (metadata) {
    for (const [key, value] of Object.entries(metadata)) {
      fields.push({
        title: key,
        value: String(value),
        short: true,
      });
    }
  }

  await fetch(SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      attachments: [
        {
          color,
          fields,
          footer: `Taswerak • ${timestamp}`,
        },
      ],
    }),
  });
}

async function sendWhatsAppAlert(payload: AlertPayload, timestamp: string): Promise<void> {
  const { level, title, message, metadata } = payload;
  const emoji = LEVEL_EMOJI[level];

  let text = `${emoji} ${title}\n\n${message}`;
  if (metadata) {
    text += "\n\n";
    for (const [key, value] of Object.entries(metadata)) {
      text += `• ${key}: ${value}\n`;
    }
  }
  text += `\n_التوقيت: ${timestamp}_`;

  await sendWhatsAppNotification({
    to: ALERT_WHATSAPP_NUMBER!,
    message: text,
  });
}

// ====================================================================
// Pre-built alert functions for common business events
// ====================================================================

export async function alertPaymentFailure(opts: {
  studentEmail: string;
  courseId: string;
  amount: number;
  currency: string;
  reason: string;
}): Promise<void> {
  await sendAlert({
    level: "critical",
    title: "فشل عملية دفع",
    message: `فشلت عملية دفع للطالب ${opts.studentEmail}`,
    metadata: {
      الدورة: opts.courseId,
      المبلغ: `${opts.amount} ${opts.currency}`,
      السبب: opts.reason,
    },
  });
}

export async function alertHealthDegraded(opts: {
  component: string;
  error: string;
}): Promise<void> {
  await sendAlert({
    level: "warning",
    title: "تدهور حالة الخدمة",
    message: `المكوّن "${opts.component}" غير صحي`,
    metadata: {
      المكوّن: opts.component,
      الخطأ: opts.error,
    },
  });
}

export async function alertWebhookSignatureFailure(opts: {
  gateway: string;
  paymentId?: string;
  ip?: string;
}): Promise<void> {
  await sendAlert({
    level: "critical",
    title: "محاولة تزوير Webhook",
    message: `تم رفض webhook غير موقّع من بوابة ${opts.gateway}`,
    metadata: {
      البوابة: opts.gateway,
      "معرف العملية": opts.paymentId || "غير متوفر",
      IP: opts.ip || "غير معروف",
    },
  });
}

export async function alertRateLimitAbuse(opts: {
  ip: string;
  endpoint: string;
  attempts: number;
}): Promise<void> {
  await sendAlert({
    level: "warning",
    title: "تجاوز Rate Limit مشبوه",
    message: `IP ${opts.ip} تجاوز حد المعدل على ${opts.endpoint}`,
    metadata: {
      IP: opts.ip,
      المسار: opts.endpoint,
      "عدد المحاولات": opts.attempts,
    },
  });
}

export async function alertStorageQuotaWarning(opts: {
  usedBytes: number;
  limitBytes: number;
}): Promise<void> {
  const usedMB = (opts.usedBytes / 1024 / 1024).toFixed(1);
  const limitMB = (opts.limitBytes / 1024 / 1024).toFixed(1);
  const percent = ((opts.usedBytes / opts.limitBytes) * 100).toFixed(1);

  await sendAlert({
    level: "warning",
    title: "تحذير مساحة التخزين",
    message: `مساحة التخزين وصلت إلى ${percent}% من الحد المسموح`,
    metadata: {
      المستخدم: `${usedMB} MB`,
      الحد: `${limitMB} MB`,
      النسبة: `${percent}%`,
    },
  });
}
