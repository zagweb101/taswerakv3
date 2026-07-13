// ====================================================================
// Taswerak — Middleware
// Uses Edge-safe authConfig only (no Prisma, no bcrypt).
// ====================================================================

import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

const { auth } = NextAuth(authConfig);

export default auth;

export const config = {
  // Skip Next internals, static assets, image optimizer, API auth routes,
  // and health check endpoints (must be reachable without auth/middleware)
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|logo.svg|robots.txt|api/auth|api/health).*)",
  ],
};
