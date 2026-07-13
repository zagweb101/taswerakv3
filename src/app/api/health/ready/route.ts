// ====================================================================
// GET /api/health/ready
// Readiness probe — returns 200 only when all critical dependencies
// are reachable and all critical env vars are set.
//
// Checks:
//   1. Database (SELECT 1)
//   2. AUTH_SECRET (or NEXTAUTH_SECRET) configured + strong enough
//   3. Storage: if STORAGE_PROVIDER=minio, pings MinIO AND verifies
//      the bucket exists (not just credentials). If local, verifies
//      the dir is writable.
//   4. Environment validation passes (no errors)
//
// Returns 503 if any check fails. Never exposes secret values.
// ====================================================================

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getEnvironmentSummary } from "@/lib/env";
import { checkStorageReadiness } from "@/lib/services/storage";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface Check {
  name: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

async function checkDatabase(): Promise<Check> {
  const start = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
    return { name: "database", ok: true, latencyMs: Date.now() - start };
  } catch (err: any) {
    return {
      name: "database",
      ok: false,
      latencyMs: Date.now() - start,
      error: (err?.message || "DB unreachable").slice(0, 120),
    };
  }
}

function checkAuthSecret(): Check {
  const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return { name: "auth_secret", ok: false, error: "AUTH_SECRET/NEXTAUTH_SECRET not set" };
  }
  if (secret.length < 32) {
    return { name: "auth_secret", ok: false, error: "AUTH_SECRET too short (<32 chars)" };
  }
  return { name: "auth_secret", ok: true };
}

async function checkStorage(): Promise<Check> {
  // Use the new checkStorageReadiness() which:
  //   - STORAGE_PROVIDER=minio: pings MinIO + verifies bucket exists
  //   - STORAGE_PROVIDER=local: verifies local dir is writable
  //   - STORAGE_PROVIDER=auto: pings MinIO if creds present, else local
  const result = await checkStorageReadiness();
  return {
    name: "storage",
    ok: result.ok,
    error: result.ok ? undefined : result.error,
  };
}

export async function GET() {
  const startedAt = Date.now();

  const [dbCheck, storageCheck] = await Promise.all([
    checkDatabase(),
    checkStorage(),
  ]);
  const authCheck = checkAuthSecret();

  const envSummary = getEnvironmentSummary();

  const checks: Check[] = [dbCheck, authCheck, storageCheck];

  // Add env validation as a check
  if (!envSummary.ok) {
    checks.push({
      name: "env_validation",
      ok: false,
      error: envSummary.errors
        .map((e) => `${e.key}: ${e.message}`)
        .join("; ")
        .slice(0, 240),
    });
  } else {
    checks.push({ name: "env_validation", ok: true });
  }

  const allOk = checks.every((c) => c.ok);
  const httpStatus = allOk ? 200 : 503;

  // Never expose secret values — only the check names + statuses + trimmed errors
  return NextResponse.json(
    {
      status: allOk ? "ok" : "down",
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
      environment: process.env.NODE_ENV || "development",
      total_latency_ms: Date.now() - startedAt,
      checks: checks.map((c) => ({
        name: c.name,
        status: c.ok ? "ok" : "down",
        latencyMs: c.latencyMs,
        error: c.ok ? undefined : c.error,
      })),
    },
    { status: httpStatus }
  );
}
