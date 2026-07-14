// ====================================================================
// Taswerak — CSRF protection helper
//
// Next.js App Router + Auth.js v5 already provides CSRF protection via:
//   1. SameSite=Lax cookies (default in Auth.js v5)
//   2. The `authorized` callback in middleware
//
// This module adds an EXPLICIT origin check for state-changing routes
// (POST/PATCH/DELETE) as defense-in-depth. It verifies that the
// `Origin` or `Referer` header matches the app's `NEXTAUTH_URL`.
//
// Usage in a route:
//   import { checkCSRF } from "@/lib/csrf";
//   const csrfError = checkCSRF(req);
//   if (csrfError) return apiError(csrfError, 403, "CSRF_DENIED");
// ====================================================================

import type { NextRequest } from "next/server";

/**
 * Verify that the request origin matches the configured app URL.
 * Returns null if OK, or an error message if the origin is suspicious.
 *
 * Only checks POST/PATCH/PUT/DELETE — GET is always allowed.
 */
export function checkCSRF(req: NextRequest | Request): string | null {
  const method = req.method.toUpperCase();

  // GET/HEAD/OPTIONS are safe methods — no CSRF check needed
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return null;
  }

  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");
  const appUrl = process.env.NEXTAUTH_URL || "";

  // If NEXTAUTH_URL is not set (dev), allow all origins
  if (!appUrl) return null;

  // Parse the expected origin from NEXTAUTH_URL
  let expectedOrigin: string;
  try {
    const u = new URL(appUrl);
    expectedOrigin = u.origin;
  } catch {
    return null; // Invalid NEXTAUTH_URL — skip check
  }

  // Check Origin header (preferred — sent by browsers on all CORS requests)
  if (origin) {
    if (origin === expectedOrigin) return null;
    return `Origin mismatch: expected ${expectedOrigin}, got ${origin}`;
  }

  // Fall back to Referer header (older browsers, some edge cases)
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.origin === expectedOrigin) return null;
      return `Referer origin mismatch: expected ${expectedOrigin}, got ${refUrl.origin}`;
    } catch {
      return `Invalid Referer header`;
    }
  }

  // No Origin or Referer header on a state-changing request — suspicious
  // But some legitimate API clients (curl, Postman) don't send these.
  // In production, we reject; in dev, we allow.
  if (process.env.NODE_ENV === "production") {
    return "Missing Origin and Referer headers on state-changing request";
  }

  return null;
}
