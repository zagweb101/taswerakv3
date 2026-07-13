// ====================================================================
// Seed script guard tests
// ====================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// Re-implement the seed guard predicate so we can test the rules
// without spinning up a Postgres connection.
const WEAK_PASSWORDS = [
  "Password123!",
  "password",
  "taswerak",
  "taswerak123",
  "admin",
  "12345678",
  "changeme",
  "change-me",
];

function isWeakPassword(pw: string): boolean {
  if (!pw || pw.length < 12) return true;
  const lower = pw.toLowerCase();
  return WEAK_PASSWORDS.some((w) => lower.includes(w.toLowerCase()));
}

function shouldAllowDemoSeed(isProduction: boolean, enableDemoSeed: string | undefined): boolean {
  if (isProduction && enableDemoSeed === "true") return false;
  return true;
}

function shouldAllowSeedAdminPassword(isProduction: boolean, pw: string | undefined): boolean {
  if (!isProduction) return true; // dev/staging — warn only
  if (!pw) return false;
  return !isWeakPassword(pw);
}

describe("seed: weak password detection", () => {
  it("rejects 'Password123!'", () => {
    expect(isWeakPassword("Password123!")).toBe(true);
  });

  it("rejects 'taswerak' and 'taswerak123'", () => {
    expect(isWeakPassword("taswerak")).toBe(true);
    expect(isWeakPassword("taswerak123")).toBe(true);
  });

  it("rejects passwords < 12 chars", () => {
    expect(isWeakPassword("Abc123!@#")).toBe(true); // 9 chars
    expect(isWeakPassword("short")).toBe(true);
  });

  it("rejects 'changeme' variants", () => {
    expect(isWeakPassword("changeme12345")).toBe(true);
    expect(isWeakPassword("Change-Me-2026")).toBe(true);
  });

  it("accepts strong passwords", () => {
    expect(isWeakPassword("c0rrect-Horse-Battery-9taple")).toBe(false);
    expect(isWeakPassword("aB3!xyZ9-pQr$sTuv")).toBe(false);
  });
});

describe("seed: demo seed guard", () => {
  it("forbids ENABLE_DEMO_SEED=true in production", () => {
    expect(shouldAllowDemoSeed(true, "true")).toBe(false);
  });

  it("allows ENABLE_DEMO_SEED=true in development", () => {
    expect(shouldAllowDemoSeed(false, "true")).toBe(true);
  });

  it("allows ENABLE_DEMO_SEED=false in production", () => {
    expect(shouldAllowDemoSeed(true, "false")).toBe(true);
  });

  it("allows undefined ENABLE_DEMO_SEED in production", () => {
    expect(shouldAllowDemoSeed(true, undefined)).toBe(true);
  });
});

describe("seed: admin password guard", () => {
  it("forbids missing admin password in production", () => {
    expect(shouldAllowSeedAdminPassword(true, undefined)).toBe(false);
    expect(shouldAllowSeedAdminPassword(true, "")).toBe(false);
  });

  it("forbids weak admin password in production", () => {
    expect(shouldAllowSeedAdminPassword(true, "Password123!")).toBe(false);
    expect(shouldAllowSeedAdminPassword(true, "taswerak123")).toBe(false);
  });

  it("allows strong admin password in production", () => {
    expect(shouldAllowSeedAdminPassword(true, "c0rrect-Horse-Battery-9taple")).toBe(true);
  });

  it("allows weak admin password in development (warn only)", () => {
    expect(shouldAllowSeedAdminPassword(false, "short")).toBe(true);
  });
});
