// ====================================================================
// Email service tests
// ====================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail, validateSmtpConfig } from "@/lib/services/email";

// Reset the singleton transporter between tests so each test starts clean.
beforeEach(() => {
  // The module keeps the transporter in a module-scoped variable; we
  // reset it via the only path available: clear process.env values that
  // would let a previously-built transporter be reused. Since each test
  // sets its own env via vi.stubEnv, this is sufficient.
  vi.unstubAllEnvs();
});

const validEmailEnv = {
  NODE_ENV: "production",
  EMAIL_TRANSPORT: "smtp",
  SMTP_HOST: "smtp.example.com",
  SMTP_PORT: "587",
  SMTP_USER: "user@example.com",
  SMTP_PASSWORD: "secret-pass",
  EMAIL_FROM: "no-reply@example.com",
};

const samplePayload = {
  to: "student@example.com",
  subject: "Test",
  html: "<p>hi</p>",
  text: "hi",
  templateId: "PAYMENT_APPROVED" as const,
  data: {},
};

describe("email: SMTP config validation", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("returns ok when all SMTP envs are present", () => {
    for (const [k, v] of Object.entries(validEmailEnv)) vi.stubEnv(k, v);
    const r = validateSmtpConfig();
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("smtp");
  });

  it("returns not-ok when SMTP_HOST missing", () => {
    for (const [k, v] of Object.entries(validEmailEnv)) vi.stubEnv(k, v);
    vi.stubEnv("SMTP_HOST", "");
    const r = validateSmtpConfig();
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("smtp");
    expect(r.error).toContain("SMTP_HOST");
  });

  it("returns not-ok when SMTP_PASSWORD missing", () => {
    for (const [k, v] of Object.entries(validEmailEnv)) vi.stubEnv(k, v);
    vi.stubEnv("SMTP_PASSWORD", "");
    const r = validateSmtpConfig();
    expect(r.ok).toBe(false);
  });
});

describe("email: production SMTP failure does NOT silently succeed", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(validEmailEnv)) vi.stubEnv(k, v);
    // Point to a non-listening port so sendMail throws
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", "1"); // nothing listening on port 1
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns ok=false with a redacted error message (no fake success)", async () => {
    const r = await sendEmail(samplePayload);
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("smtp");
    expect(r.error).toBeTruthy();
    // Error must NOT contain the password
    expect(r.error).not.toContain("secret-pass");
  }, 15000);
});

describe("email: simulation mode is used in development", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("EMAIL_TRANSPORT", "simulation");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns ok=true with mode=simulation", async () => {
    const r = await sendEmail(samplePayload);
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("simulation");
  });
});

describe("email: simulation forbidden in production", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EMAIL_TRANSPORT", "simulation");
    // SMTP not configured either
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASSWORD", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("returns ok=false when simulation is requested but SMTP not configured", async () => {
    const r = await sendEmail(samplePayload);
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("smtp");
  });
});
