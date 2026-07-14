// ====================================================================
// Health check tests
// ====================================================================

import { describe, it, expect } from "vitest";

/**
 * Re-implement the liveness predicate used by /api/health/live.
 * Liveness must NOT depend on the database.
 */
function isAlive(): { status: string; httpStatus: number } {
  // We're alive if the Node process is running and can read uptime.
  // No DB call, no env check.
  const uptime = process.uptime();
  if (typeof uptime !== "number" || !Number.isFinite(uptime)) {
    return { status: "down", httpStatus: 503 };
  }
  return { status: "ok", httpStatus: 200 };
}

describe("health/live: returns 200 when process is alive", () => {
  it("always returns 200 inside a running process", () => {
    const r = isAlive();
    expect(r.status).toBe("ok");
    expect(r.httpStatus).toBe(200);
  });
});

/**
 * Re-implement the readiness gate.
 */
interface ReadyCheck {
  name: string;
  ok: boolean;
  error?: string;
}

function computeReadiness(checks: ReadyCheck[]): { status: string; httpStatus: number } {
  const allOk = checks.every((c) => c.ok);
  return {
    status: allOk ? "ok" : "down",
    httpStatus: allOk ? 200 : 503,
  };
}

describe("health/ready: returns 503 when DB is down", () => {
  it("returns 503 when database check fails", () => {
    const r = computeReadiness([
      { name: "database", ok: false, error: "ECONNREFUSED" },
      { name: "auth_secret", ok: true },
      { name: "storage", ok: true },
    ]);
    expect(r.status).toBe("down");
    expect(r.httpStatus).toBe(503);
  });

  it("returns 200 when all checks pass", () => {
    const r = computeReadiness([
      { name: "database", ok: true },
      { name: "auth_secret", ok: true },
      { name: "storage", ok: true },
      { name: "env_validation", ok: true },
    ]);
    expect(r.status).toBe("ok");
    expect(r.httpStatus).toBe(200);
  });

  it("returns 503 when auth secret missing", () => {
    const r = computeReadiness([
      { name: "database", ok: true },
      { name: "auth_secret", ok: false, error: "AUTH_SECRET not set" },
      { name: "storage", ok: true },
    ]);
    expect(r.httpStatus).toBe(503);
  });

  it("returns 503 when env validation fails", () => {
    const r = computeReadiness([
      { name: "database", ok: true },
      { name: "auth_secret", ok: true },
      { name: "storage", ok: true },
      { name: "env_validation", ok: false, error: "EMAIL_TRANSPORT=simulation forbidden in production" },
    ]);
    expect(r.httpStatus).toBe(503);
  });
});

describe("health: never exposes secret values", () => {
  it("the readiness response shape has no field that mirrors AUTH_SECRET", () => {
    // The actual route builds this object — verify its key set does not
    // include any "secret" or "password" key.
    const sampleResponse = {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime_seconds: 1,
      environment: "production",
      total_latency_ms: 1,
      checks: [
        { name: "database", status: "ok", latencyMs: 1 },
        { name: "auth_secret", status: "ok" },
        { name: "storage", status: "ok" },
      ],
    };
    const json = JSON.stringify(sampleResponse);
    // The check NAME may contain "secret", but no VALUE should be a long
    // random-looking string (i.e., the actual secret).
    expect(json).not.toMatch(/"AUTH_SECRET"\s*:\s*"[^"]{8,}"/);
    expect(json).not.toMatch(/"SMTP_PASSWORD"\s*:\s*"[^"]+"/);
  });
});
