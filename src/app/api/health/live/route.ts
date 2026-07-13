// ====================================================================
// GET /api/health/live
// Liveness probe — returns 200 if the Node.js process is alive.
// Does NOT touch the database or any other dependency.
// Use this for Kubernetes/Coolify livenessProbe.
// ====================================================================

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime_seconds: Math.floor(process.uptime()),
    },
    { status: 200 }
  );
}
