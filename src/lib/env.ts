// ====================================================================
// Taswerak — Environment validation
// In production, refuses to boot if critical environment variables are missing
// or weak. In development, logs warnings but does not throw.
//
// Usage:
//   import { assertEnvironment, validateEnvironment } from "@/lib/env";
//   const result = validateEnvironment();
//   if (!result.ok) { /* handle */ }
// ====================================================================

export interface EnvIssue {
  level: "error" | "warn";
  key: string;
  message: string;
}

export interface EnvResult {
  ok: boolean;
  issues: EnvIssue[];
  /** True if NODE_ENV === "production" */
  isProduction: boolean;
}

const PROD = process.env.NODE_ENV === "production";

function isHttps(url?: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function secretStrength(secret?: string): "missing" | "weak" | "ok" {
  if (!secret) return "missing";
  if (secret.length < 32) return "weak";
  // Reject obvious placeholders
  const placeholders = [
    "change-me",
    "changeme",
    "placeholder",
    "your-secret",
    "todo",
    "xxxxx",
    "test-test",
  ];
  if (placeholders.some((p) => secret.toLowerCase().includes(p))) return "weak";
  return "ok";
}

/**
 * Validate the current process.env against the production readiness rules.
 * Pure function — does not throw, does not exit. Caller decides what to do.
 */
export function validateEnvironment(env: NodeJS.ProcessEnv = process.env): EnvResult {
  const issues: EnvIssue[] = [];
  const isProd = env.NODE_ENV === "production";

  // ---------- AUTH_SECRET ----------
  const authStrength = secretStrength(env.AUTH_SECRET);
  if (authStrength === "missing") {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "AUTH_SECRET",
      message: "AUTH_SECRET is missing — auth tokens will be unsigned.",
    });
  } else if (authStrength === "weak") {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "AUTH_SECRET",
      message: "AUTH_SECRET is weak — must be ≥32 random chars and not a placeholder.",
    });
  }

  // NEXTAUTH_SECRET fallback (legacy)
  const nextAuthStrength = secretStrength(env.NEXTAUTH_SECRET);
  if (authStrength === "missing" && nextAuthStrength === "ok") {
    // Acceptable — NEXTAUTH_SECRET is being used
  } else if (authStrength === "missing" && nextAuthStrength !== "ok" && isProd) {
    issues.push({
      level: "error",
      key: "NEXTAUTH_SECRET",
      message: "Either AUTH_SECRET or NEXTAUTH_SECRET must be set in production.",
    });
  }

  // ---------- DATABASE_URL ----------
  if (!env.DATABASE_URL) {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "DATABASE_URL",
      message: "DATABASE_URL is missing — app cannot connect to PostgreSQL.",
    });
  } else if (env.DATABASE_URL.includes(":taswerak@") && isProd) {
    issues.push({
      level: "error",
      key: "DATABASE_URL",
      message: "DATABASE_URL uses the default dev password 'taswerak' — rejected in production.",
    });
  } else if (env.DATABASE_URL.includes("postgres:123456") && isProd) {
    issues.push({
      level: "error",
      key: "DATABASE_URL",
      message: "DATABASE_URL uses the seed default password — rejected in production.",
    });
  }

  // ---------- NEXTAUTH_URL ----------
  if (!env.NEXTAUTH_URL) {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "NEXTAUTH_URL",
      message: "NEXTAUTH_URL is missing — auth redirects will break.",
    });
  } else if (isProd && !isHttps(env.NEXTAUTH_URL)) {
    issues.push({
      level: "error",
      key: "NEXTAUTH_URL",
      message: `NEXTAUTH_URL must be HTTPS in production (got ${env.NEXTAUTH_URL}).`,
    });
  }

  // ---------- SMTP ----------
  // SMTP is required when EMAIL_TRANSPORT=smtp, otherwise optional.
  const transport = (env.EMAIL_TRANSPORT || "simulation").toLowerCase();
  const smtpRequired = transport === "smtp" || isProd;
  const smtpFields = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"];
  const missingSmtp = smtpFields.filter((k) => !env[k]);
  if (smtpRequired && missingSmtp.length > 0) {
    issues.push({
      level: isProd ? "error" : "warn",
      key: "SMTP",
      message: `SMTP required but missing: ${missingSmtp.join(", ")}.`,
    });
  }
  // In production we must NOT use simulation transport for sensitive emails.
  if (isProd && transport === "simulation") {
    issues.push({
      level: "error",
      key: "EMAIL_TRANSPORT",
      message: "EMAIL_TRANSPORT=simulation is forbidden in production.",
    });
  }

  // ---------- Payment gateways ----------
  const gateway = (env.PAYMENT_GATEWAY || "manual").toLowerCase();
  if (gateway === "moyasar" && !env.MOYASAR_SECRET_KEY) {
    issues.push({
      level: "error",
      key: "MOYASAR_SECRET_KEY",
      message: "PAYMENT_GATEWAY=moyasar but MOYASAR_SECRET_KEY is not set.",
    });
  }
  if (gateway === "tap" && !env.TAP_SECRET_KEY) {
    issues.push({
      level: "error",
      key: "TAP_SECRET_KEY",
      message: "PAYMENT_GATEWAY=tap but TAP_SECRET_KEY is not set.",
    });
  }
  // Webhook secrets (highly recommended when gateway is enabled)
  if (gateway === "moyasar" && !env.MOYASAR_WEBHOOK_SECRET && isProd) {
    issues.push({
      level: "warn",
      key: "MOYASAR_WEBHOOK_SECRET",
      message: "Moyasar webhook secret not set — webhooks cannot be verified (fail-closed).",
    });
  }
  if (gateway === "tap" && !env.TAP_WEBHOOK_SECRET && isProd) {
    issues.push({
      level: "warn",
      key: "TAP_WEBHOOK_SECRET",
      message: "Tap webhook secret not set — webhooks cannot be verified (fail-closed).",
    });
  }

  // ---------- Storage ----------
  const storageProvider = (env.STORAGE_PROVIDER || (env.MINIO_ACCESS_KEY ? "minio" : "local")).toLowerCase();
  if (storageProvider === "minio") {
    const minioKeys = ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY"];
    const missingMinio = minioKeys.filter((k) => !env[k]);
    if (missingMinio.length > 0) {
      issues.push({
        level: isProd ? "error" : "warn",
        key: "MINIO",
        message: `MinIO selected but missing: ${missingMinio.join(", ")}.`,
      });
    }
  } else if (storageProvider === "local") {
    if (isProd && !env.LOCAL_STORAGE_DIR) {
      issues.push({
        level: "warn",
        key: "LOCAL_STORAGE_DIR",
        message:
          "Local storage is in use but LOCAL_STORAGE_DIR is not set. " +
          "Mount a persistent volume to that path or you will lose uploaded files on redeploy.",
      });
    }
  }

  // ---------- Seed guard ----------
  if (isProd && env.ENABLE_DEMO_SEED === "true") {
    issues.push({
      level: "error",
      key: "ENABLE_DEMO_SEED",
      message: "ENABLE_DEMO_SEED=true is forbidden in production.",
    });
  }
  if (isProd) {
    if (!env.SEED_ADMIN_EMAIL || !env.SEED_ADMIN_PASSWORD) {
      issues.push({
        level: "warn",
        key: "SEED_ADMIN_*",
        message:
          "SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set — seed will not create an admin in production.",
      });
    } else if ((env.SEED_ADMIN_PASSWORD || "").length < 12) {
      issues.push({
        level: "error",
        key: "SEED_ADMIN_PASSWORD",
        message: "SEED_ADMIN_PASSWORD must be at least 12 characters in production.",
      });
    }
  }

  const errors = issues.filter((i) => i.level === "error");
  return {
    ok: errors.length === 0,
    issues,
    isProduction: isProd,
  };
}

/**
 * Hard assertion — call at server boot. Logs errors and exits in production.
 */
export function assertEnvironment(env: NodeJS.ProcessEnv = process.env): EnvResult {
  const result = validateEnvironment(env);
  const errors = result.issues.filter((i) => i.level === "error");
  const warnings = result.issues.filter((i) => i.level === "warn");

  for (const w of warnings) {
    console.warn(`[env] WARN ${w.key}: ${w.message}`);
  }
  if (errors.length > 0) {
    for (const e of errors) {
      console.error(`[env] FAIL ${e.key}: ${e.message}`);
    }
    if (result.isProduction) {
      console.error("[env] Refusing to boot in production with the errors above.");
      process.exit(1);
    } else {
      console.warn("[env] Running in non-production — continuing despite errors above.");
    }
  }
  return result;
}

/**
 * Convenience accessor used by /api/health/ready.
 */
export function getEnvironmentSummary() {
  const result = validateEnvironment();
  return {
    ok: result.ok,
    isProduction: result.isProduction,
    errors: result.issues
      .filter((i) => i.level === "error")
      .map((i) => ({ key: i.key, message: i.message })),
    warnings: result.issues
      .filter((i) => i.level === "warn")
      .map((i) => ({ key: i.key, message: i.message })),
  };
}
