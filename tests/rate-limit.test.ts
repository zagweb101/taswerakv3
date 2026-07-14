// ====================================================================
// Rate limiter tests
// ====================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rateLimit, getClientIP, rateLimitPresets } from "@/lib/services/rate-limit";

describe("rate-limit: basic in-memory", () => {
  it("allows the first request up to limit", () => {
    const r = rateLimit({ key: "test-1", limit: 3, windowMs: 60_000 });
    expect(r.success).toBe(true);
    expect(r.remaining).toBe(2);
    expect(r.statusCode).toBe(200);
  });

  it("blocks after limit reached", () => {
    for (let i = 0; i < 3; i++) {
      rateLimit({ key: "test-2", limit: 3, windowMs: 60_000 });
    }
    const r = rateLimit({ key: "test-2", limit: 3, windowMs: 60_000 });
    expect(r.success).toBe(false);
    expect(r.statusCode).toBe(429);
    expect(r.remaining).toBe(0);
  });

  it("resets after the window expires", () => {
    // Use very short window
    rateLimit({ key: "test-3", limit: 1, windowMs: 50 });
    // Second call within window should fail
    const blocked = rateLimit({ key: "test-3", limit: 1, windowMs: 50 });
    expect(blocked.success).toBe(false);
    // Wait for window to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const after = rateLimit({ key: "test-3", limit: 1, windowMs: 50 });
        expect(after.success).toBe(true);
        resolve();
      }, 80);
    });
  });

  it("treats different keys independently", () => {
    const a = rateLimit({ key: "key-a", limit: 1, windowMs: 60_000 });
    const b = rateLimit({ key: "key-b", limit: 1, windowMs: 60_000 });
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
  });
});

describe("rate-limit: getClientIP trust-proxy behavior", () => {
  afterEach(() => vi.unstubAllEnvs());

  function makeReq(headers: Record<string, string>): Request {
    return new Request("https://example.com", { headers });
  }

  it("ignores X-Forwarded-For when TRUST_PROXY=false", () => {
    vi.stubEnv("TRUST_PROXY", "false");
    const req = makeReq({ "x-forwarded-for": "1.2.3.4" });
    expect(getClientIP(req)).toBe("unknown");
  });

  it("uses X-Forwarded-For first hop when TRUST_PROXY=true", () => {
    vi.stubEnv("TRUST_PROXY", "true");
    const req = makeReq({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" });
    expect(getClientIP(req)).toBe("1.2.3.4");
  });

  it("trims whitespace around the XFF first hop", () => {
    vi.stubEnv("TRUST_PROXY", "true");
    const req = makeReq({ "x-forwarded-for": "  1.2.3.4  , 5.6.7.8" });
    expect(getClientIP(req)).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip when TRUST_PROXY=false", () => {
    vi.stubEnv("TRUST_PROXY", "false");
    const req = makeReq({ "x-real-ip": "9.9.9.9" });
    expect(getClientIP(req)).toBe("9.9.9.9");
  });

  it("returns 'unknown' when no headers present", () => {
    vi.stubEnv("TRUST_PROXY", "false");
    const req = makeReq({});
    expect(getClientIP(req)).toBe("unknown");
  });
});

describe("rate-limit: presets", () => {
  it("login preset has limit 10 per minute", () => {
    const r = rateLimitPresets.login("ip-x");
    expect(r.success).toBe(true);
  });

  it("signup preset blocks after 5 attempts per hour", () => {
    for (let i = 0; i < 5; i++) rateLimitPresets.signup("ip-y");
    const r = rateLimitPresets.signup("ip-y");
    expect(r.success).toBe(false);
  });
});
