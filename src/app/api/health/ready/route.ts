// ====================================================================
// GET /api/health/ready
// Readiness probe — returns 200 only when all critical dependencies
// are reachable and all critical env vars are set.
//
// Checks:
//   1. Database (SELECT 1)
//   2. AUTH_SECRET (or NEXTAUTH_SECRET) configured + strong enough
//   3. Storage configuration (MinIO creds present OR local dir writable)
//   4. Environment validation passes (no errors)
//
// Returns 503 if any check fails. Never exposes secret values.
// ====================================================================

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getEnvironmentSummary } from "@/lib/env";
import { storageStatus } from "@/lib/services/storage";
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
  // If MinIO is configured, just verify creds are present (don't ping —
  // MinIO may be temporarily down without affecting the whole app since
  // we fall back to local). If local, verify the dir is writable.
  const provider = storageStatus.provider;
  if (provider === "minio") {
    if (!process.env.MINIO_ACCESS_KEY || !process.env.MINIO_SECRET_KEY) {
      return { name: "storage", ok: false, error: "MinIO selected but creds missing" };
    }
    return { name: "storage", ok: true };
  }
  // local — verify dir is writable
  try {
    const dir = storageStatus.localStorageDir;
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, ".ready-probe");
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { name: "storage", ok: true };
  } catch (err: any) {
    return {
      name: "storage",
      ok: false,
      error: (err?.message || "Storage dir not writable").slice(0, 120),
    };
  }
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
