// ====================================================================
// GET /api/health
// Legacy alias for /api/health/ready. Prefer using /api/health/ready
// (readiness probe) and /api/health/live (liveness probe) directly.
// ====================================================================

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getEnvironmentSummary } from "@/lib/env";
import { storageStatus } from "@/lib/services/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HealthCheck {
  name: string;
  status: "ok" | "down";
  latencyMs?: number;
  error?: string;
}

export async function GET(_req?: NextRequest) {
  const checks: HealthCheck[] = [];
  const startedAt = Date.now();

  // 1. Database
  const dbStart = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    checks.push({ name: "database", status: "ok", latencyMs: Date.now() - dbStart });
  } catch (err: any) {
    checks.push({
      name: "database",
      status: "down",
      latencyMs: Date.now() - dbStart,
      error: err?.message?.slice(0, 100) || "DB unreachable",
    });
  }

  // 2. Storage config
  const storageOk =
    storageStatus.provider === "minio"
      ? !!(process.env.MINIO_ACCESS_KEY && process.env.MINIO_SECRET_KEY)
      : true; // local always "configured"
  checks.push({
    name: "storage_config",
    status: storageOk ? "ok" : "down",
    error: storageOk ? undefined : "MINIO_* env vars missing",
  });

  // 3. Auth secret
  const authOk = !!(process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET);
  checks.push({
    name: "auth_config",
    status: authOk ? "ok" : "down",
    error: authOk ? undefined : "AUTH_SECRET missing",
  });

  // 4. Env validation
  const env = getEnvironmentSummary();
  checks.push({
    name: "env_validation",
    status: env.ok ? "ok" : "down",
    error: env.ok
      ? undefined
      : env.errors.map((e) => e.key).join(", "),
  });

  const dbHealthy = checks.find((c) => c.name === "database")?.status === "ok";
  const overallStatus = checks.every((c) => c.status === "ok") ? "ok" : dbHealthy ? "degraded" : "down";
  const httpStatus = checks.every((c) => c.status === "ok") ? 200 : 503;

  return NextResponse.json(
    {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      version: process.env.npm_package_version || "1.0.0",
      environment: process.env.NODE_ENV || "development",
      total_latency_ms: Date.now() - startedAt,
      checks,
    },
    { status: httpStatus }
  );
}
