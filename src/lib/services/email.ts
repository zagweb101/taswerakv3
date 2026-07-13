// ====================================================================
// Taswerak — Email service (production-ready)
//
// Rules:
//   - simulation mode is allowed ONLY in development / staging.
//   - In production, SMTP must be configured. If SMTP fails, return
//     { ok: false, mode: "smtp", error: "<redacted>" } — do NOT silently
//     fall back to simulation.
//   - Never log the SMTP password. Errors are logged with the password
//     field stripped.
//   - Result shape: { ok: boolean; mode: "simulation" | "smtp"; error?: string }
// ====================================================================

import { promises as fs } from "fs";
import path from "path";

type Transport = "simulation" | "smtp";

// Read env at CALL time so tests + hot-reloads see fresh values.
function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

function isStagingEnv(): boolean {
  return (process.env.NODE_ENV || "").toLowerCase() === "staging";
}

function simulationAllowed(): boolean {
  return !isProductionEnv(); // dev or staging
}

function getTransport(): Transport {
  const isProd = isProductionEnv();
  const t = (process.env.EMAIL_TRANSPORT || (isProd ? "smtp" : "simulation")).toLowerCase();
  if (t === "smtp") return "smtp";
  if (t === "simulation") {
    if (!simulationAllowed()) {
      // Force smtp in production even if someone misconfigures env
      return "smtp";
    }
    return "simulation";
  }
  return isProd ? "smtp" : "simulation";
}

function fromAddress(): string {
  return process.env.EMAIL_FROM || "Taswerak <no-reply@taswerak.com>";
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
  templateId: EmailTemplate;
  data: Record<string, unknown>;
}

export type EmailTemplate =
  | "PAYMENT_APPROVED"
  | "PAYMENT_REJECTED"
  | "CERTIFICATE_ISSUED"
  | "CRITIQUE_RECEIVED"
  | "WELCOME"
  | "PASSWORD_RESET";

export interface EmailResult {
  ok: boolean;
  mode: Transport;
  error?: string;
}

/**
 * Validate SMTP env is configured. Returns a structured error if not.
 */
export function validateSmtpConfig(): EmailResult {
  const transport = getTransport();
  if (transport === "simulation") {
    return { ok: true, mode: "simulation" };
  }
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    return {
      ok: false,
      mode: "smtp",
      error: `SMTP not configured — missing: ${missing.join(", ")}`,
    };
  }
  return { ok: true, mode: "smtp" };
}

/**
 * Send an email. Always returns a structured result.
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailResult> {
  const transport = getTransport();

  if (transport === "simulation") {
    return simulateEmail(payload);
  }
  return smtpEmail(payload);
}

async function simulateEmail(payload: EmailPayload): Promise<EmailResult> {
  const { to, subject, html, text, templateId, data } = payload;
  const stamp = new Date().toISOString();
  const summary = `[${stamp}] TO: ${to}\nSUBJECT: ${subject}\nTEMPLATE: ${templateId}\nDATA: ${JSON.stringify(
    data
  )}\n----\n${text || "(no plain text body)"}\n================\n`;

  console.log("━━━━━━━━━━━━━━ EMAIL (simulation) ━━━━━━━━━━━━━━");
  console.log(summary);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  // Persist to disk in dev so admin can review
  try {
    const dir = path.join(process.cwd(), ".upload", "_emails");
    await fs.mkdir(dir, { recursive: true });
    const safeFile = `${stamp.replace(/[:.]/g, "-")}_${templateId}.log`;
    await fs.writeFile(path.join(dir, safeFile), `${summary}\n\nHTML:\n${html}\n`);
  } catch (err) {
    console.warn("[email] could not persist simulation log:", err);
  }

  return { ok: true, mode: "simulation" };
}

// Singleton SMTP transporter
let globalTransporter: any = null;

async function smtpEmail(payload: EmailPayload): Promise<EmailResult> {
  const isProd = isProductionEnv();
  const cfg = validateSmtpConfig();
  if (!cfg.ok) {
    // SMTP not configured
    if (isProd) {
      // In production we MUST NOT silently fall back to simulation.
      console.error("[email] SMTP not configured — refusing to send in production");
      return { ok: false, mode: "smtp", error: cfg.error };
    }
    // In dev/staging, fall back to simulation with a loud warning
    console.warn("[email] SMTP not configured — falling back to simulation in non-production");
    return simulateEmail(payload);
  }

  try {
    const nodemailer = await import("nodemailer");
    if (!globalTransporter) {
      globalTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || "587", 10),
        secure: parseInt(process.env.SMTP_PORT || "587", 10) === 465,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      });
    }

    await globalTransporter.sendMail({
      from: fromAddress(),
      to: payload.to,
      subject: payload.subject,
      html: payload.html,
      text: payload.text,
    });

    return { ok: true, mode: "smtp" };
  } catch (err: any) {
    // Strip credentials from error before logging
    const safeMessage = (err?.message || "SMTP error")
      .replace(/(password|pass|secret|key|auth)[^\s]*/gi, "$1=***");
    console.error("[email] SMTP failed:", safeMessage);
    globalTransporter = null; // recreate on next attempt
    if (isProd) {
      // DO NOT fall back to simulation in production
      return { ok: false, mode: "smtp", error: safeMessage };
    }
    // Non-production: fall back to simulation so devs can still see the email
    console.warn("[email] Falling back to simulation in non-production");
    return simulateEmail(payload);
  }
}

// ====================================================================
// Templates (unchanged from previous version)
// ====================================================================

export function renderPaymentApprovedEmail(opts: {
  studentName: string;
  courseName: string;
  amount: number;
  currency: string;
}): EmailPayload {
  const { studentName, courseName, amount, currency } = opts;
  return {
    to: "",
    subject: `تم اعتماد دفعتك — ${courseName} | تصويرك`,
    templateId: "PAYMENT_APPROVED",
    data: opts,
    text: `أهلاً ${studentName}،

تم اعتماد دفعتك بمبلغ ${amount} ${currency} لدورة "${courseName}".

يمكنك الآن البدء في الدورة من لوحة التحكم:
${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/courses

تحياتنا،
فريق تصويرك`,
    html: `
<div dir="rtl" style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <div style="background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); padding: 24px; border-radius: 16px 16px 0 0; text-align: center;">
    <div style="color: white; font-size: 28px; font-weight: 800;">تصويرك</div>
  </div>
  <div style="background: white; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
    <h1 style="font-size: 22px; color: #0A9ED9; margin-top: 0;">تم اعتماد دفعتك ✅</h1>
    <p style="color: #374151; line-height: 1.7;">أهلاً <strong>${escapeHtml(studentName)}</strong>،</p>
    <p style="color: #374151; line-height: 1.7;">
      تم اعتماد دفعتك بمبلغ <strong>${amount} ${currency}</strong> لدورة
      <strong>"${escapeHtml(courseName)}"</strong>. يمكنك الآن البدء في مشاهددة المحاضرات
      ورفع أعمالك للنقد.
    </p>
    <a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/courses" style="display: inline-block; background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); color: white; padding: 12px 28px; border-radius: 12px; text-decoration: none; font-weight: 600; margin-top: 16px;">
      ابدأ الدورة الآن
    </a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
      تحياتنا،<br/>فريق تصويرك
    </p>
  </div>
</div>
`,
  };
}

export function renderPaymentRejectedEmail(opts: {
  studentName: string;
  courseName: string;
  amount: number;
  currency: string;
  rejectionReason: string;
}): EmailPayload {
  const { studentName, courseName, amount, currency, rejectionReason } = opts;
  return {
    to: "",
    subject: `تحتاج دفعتك لمراجعة — ${courseName} | تصويرك`,
    templateId: "PAYMENT_REJECTED",
    data: opts,
    text: `أهلاً ${studentName}،

للأسف لم نتمكن من اعتماد دفعتك بمبلغ ${amount} ${currency} لدورة "${courseName}".

السبب: ${rejectionReason}

يمكنك رفع إيصال جديد من لوحة التحكم:
${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/payments

تحياتنا،
فريق تصويرك`,
    html: `
<div dir="rtl" style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <div style="background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); padding: 24px; border-radius: 16px 16px 0 0; text-align: center;">
    <div style="color: white; font-size: 28px; font-weight: 800;">تصويرك</div>
  </div>
  <div style="background: white; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
    <h1 style="font-size: 22px; color: #D65221; margin-top: 0;">تحتاج دفعتك لمراجعة ⚠️</h1>
    <p style="color: #374151; line-height: 1.7;">أهلاً <strong>${escapeHtml(studentName)}</strong>،</p>
    <p style="color: #374151; line-height: 1.7;">
      للأسف لم نتمكن من اعتماد دفعتك بمبلغ <strong>${amount} ${currency}</strong>
      لدورة <strong>"${escapeHtml(courseName)}"</strong>.
    </p>
    <div style="background: #fef3c7; border: 1px solid #fde68a; padding: 12px 16px; border-radius: 12px; margin: 16px 0;">
      <strong>السبب:</strong> ${escapeHtml(rejectionReason)}
    </div>
    <p style="color: #374151; line-height: 1.7;">
      يمكنك رفع إيصال جديد بعد التحقق من البيانات.
    </p>
    <a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/payments" style="display: inline-block; background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); color: white; padding: 12px 28px; border-radius: 12px; text-decoration: none; font-weight: 600; margin-top: 16px;">
      رفع إيصال جديد
    </a>
    <p style="color: #6b7280; font-size: 13px; margin-top: 24px;">
      تحياتنا،<br/>فريق تصويرك
    </p>
  </div>
</div>
`,
  };
}

export function renderCertificateIssuedEmail(opts: {
  studentName: string;
  courseName: string;
  certificateNumber: string;
  grade: string;
}): EmailPayload {
  const { studentName, courseName, certificateNumber, grade } = opts;
  return {
    to: "",
    subject: `شهادتك جاهزة — ${courseName} | تصويرك`,
    templateId: "CERTIFICATE_ISSUED",
    data: opts,
    text: `أهلاً ${studentName}،

مبروك! تم إصدار شهادتك لإتمام دورة "${courseName}".

رقم الشهادة: ${certificateNumber}
التقدير: ${grade}

حمّل شهادتك من:
${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/certificates

تحياتنا،
فريق تصويرك`,
    html: `
<div dir="rtl" style="font-family: system-ui, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
  <div style="background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); padding: 24px; border-radius: 16px 16px 0 0; text-align: center;">
    <div style="color: white; font-size: 28px; font-weight: 800;">تصويرك</div>
  </div>
  <div style="background: white; padding: 32px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 16px 16px;">
    <h1 style="font-size: 22px; color: #00A3AA; margin-top: 0;">شهادتك جاهزة 🎓</h1>
    <p style="color: #374151; line-height: 1.7;">مبروك <strong>${escapeHtml(studentName)}</strong>،</p>
    <p style="color: #374151; line-height: 1.7;">
      تم إصدار شهادتك لإتمام دورة <strong>"${escapeHtml(courseName)}"</strong>.
    </p>
    <div style="background: #f0fdfa; border: 1px solid #ccfbf1; padding: 16px; border-radius: 12px; margin: 16px 0; text-align: center;">
      <div style="font-size: 12px; color: #6b7280;">رقم الشهادة</div>
      <div style="font-family: monospace; font-weight: 700; font-size: 16px; color: #00A3AA; letter-spacing: 1px;">${certificateNumber}</div>
      <div style="font-size: 12px; color: #6b7280; margin-top: 8px;">التقدير: <strong>${grade}</strong></div>
    </div>
    <a href="${process.env.NEXTAUTH_URL || "http://localhost:3000"}/student/certificates" style="display: inline-block; background: linear-gradient(135deg, #0A9ED9, #00A3AA, #D65221); color: white; padding: 12px 28px; border-radius: 12px; text-decoration: none; font-weight: 600; margin-top: 16px;">
      تحميل الشهادة
    </a>
  </div>
</div>
`,
  };
}
