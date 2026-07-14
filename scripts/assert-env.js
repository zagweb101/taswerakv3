// ====================================================================
// Boot-time environment validation script (CommonJS, no deps).
//
// This script runs BEFORE prisma migrate deploy and BEFORE the Next.js
// server starts. In production, it exits non-zero if critical env vars
// are missing — causing the Docker container to restart (or fail loudly).
//
// In development/staging, it logs warnings but exits 0 so the app can
// still start (with reduced functionality).
//
// This is a self-contained re-implementation of the validation logic
// in src/lib/env.ts (which uses ES modules and can't be required()
// directly from a CommonJS script). Keep the two in sync.
//
// Usage:
//   node scripts/assert-env.js
// ====================================================================

const PROD = process.env.NODE_ENV === "production";

function isHttps(url) {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function secretStrength(secret) {
  if (!secret) return "missing";
  if (secret.length < 32) return "weak";
  const placeholders = [
    "change-me", "changeme", "placeholder", "your-secret",
    "todo", "xxxxx", "test-test",
  ];
  if (placeholders.some((p) => secret.toLowerCase().includes(p))) return "weak";
  return "ok";
}

const errors = [];
const warnings = [];

// AUTH_SECRET
const authStrength = secretStrength(process.env.AUTH_SECRET);
if (authStrength === "missing") {
  (PROD ? errors : warnings).push("AUTH_SECRET is missing");
} else if (authStrength === "weak") {
  (PROD ? errors : warnings).push("AUTH_SECRET is weak (must be ≥32 random chars)");
}

// DATABASE_URL
if (!process.env.DATABASE_URL) {
  (PROD ? errors : warnings).push("DATABASE_URL is missing");
} else if (PROD) {
  if (process.env.DATABASE_URL.includes(":taswerak@") ||
      process.env.DATABASE_URL.includes("postgres:123456")) {
    errors.push("DATABASE_URL uses a known dev password in production");
  }
}

// NEXTAUTH_URL
if (!process.env.NEXTAUTH_URL) {
  (PROD ? errors : warnings).push("NEXTAUTH_URL is missing");
} else if (PROD && !isHttps(process.env.NEXTAUTH_URL)) {
  errors.push(`NEXTAUTH_URL must be HTTPS in production (got ${process.env.NEXTAUTH_URL})`);
}

// SMTP
const transport = (process.env.EMAIL_TRANSPORT || (PROD ? "smtp" : "simulation")).toLowerCase();
if (PROD && transport === "simulation") {
  errors.push("EMAIL_TRANSPORT=simulation is forbidden in production");
}
const smtpRequired = transport === "smtp" || PROD;
if (smtpRequired) {
  const missing = ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM"].filter((k) => !process.env[k]);
  if (missing.length > 0) {
    (PROD ? errors : warnings).push(`SMTP required but missing: ${missing.join(", ")}`);
  }
}

// Payment gateways
const gateway = (process.env.PAYMENT_GATEWAY || "manual").toLowerCase();
if (gateway === "moyasar" && !process.env.MOYASAR_SECRET_KEY) {
  errors.push("PAYMENT_GATEWAY=moyasar but MOYASAR_SECRET_KEY is not set");
}
if (gateway === "tap" && !process.env.TAP_SECRET_KEY) {
  errors.push("PAYMENT_GATEWAY=tap but TAP_SECRET_KEY is not set");
}

// Demo seed
if (PROD && process.env.ENABLE_DEMO_SEED === "true") {
  errors.push("ENABLE_DEMO_SEED=true is forbidden in production");
}

// Seed admin
if (PROD) {
  if (!process.env.SEED_ADMIN_EMAIL || !process.env.SEED_ADMIN_PASSWORD) {
    warnings.push("SEED_ADMIN_EMAIL/PASSWORD not set — seed will not create an admin");
  } else if (process.env.SEED_ADMIN_PASSWORD.length < 12) {
    errors.push("SEED_ADMIN_PASSWORD must be ≥12 chars in production");
  }
}

// Print
if (warnings.length > 0) {
  for (const w of warnings) console.warn(`[env] WARN ${w}`);
}
if (errors.length > 0) {
  for (const e of errors) console.error(`[env] FAIL ${e}`);
  if (PROD) {
    console.error("");
    console.error("❌ Environment validation failed — refusing to boot in production.");
    process.exit(1);
  } else {
    console.warn("[env] Non-production — continuing despite errors above.");
  }
} else {
  console.log("✅ Environment validation passed.");
}
process.exit(0);
