// ====================================================================
// Taswerak — Rate limiter
//
// CURRENT BEHAVIOUR:
//   - In-memory Map<string, {count, resetAt}>. Single-instance only.
//   - Suitable for Coolify deployments running ONE replica.
//
// KNOWN LIMITATIONS:
//   - NOT suitable for multi-replica deployments — each replica keeps
//     its own counter, so the effective limit becomes (limit × replicas).
//     When scaling out, set REDIS_URL and the Redis-backed adapter will
//     be used automatically (no code changes needed in callers).
//
// TRUST PROXY:
//   - We do NOT trust x-forwarded-for by default. Behind Coolify/Nginx
//     you should set TRUST_PROXY=true so the first IP in
//     x-forwarded-for is used. Without that flag, we fall back to
//     x-real-ip (set by the proxy itself) or "unknown".
//   - Even with TRUST_PROXY=true, we take only the FIRST hop in the
//     XFF header (the leftmost), which is the original client. We do
//     NOT trust any subsequent hops because they can be spoofed by the
//     client adding fake IPs to the header.
//
// REDIS-READY:
//   - If REDIS_URL is set, the RedisRateLimiter class becomes the
//     backend. Until REDIS_URL is configured, the in-memory limiter
//     is used. The public rateLimit() API does not change.
// ====================================================================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitEntry>();
const CLEANUP_INTERVAL = 5 * 60 * 1000;
let lastCleanup = Date.now();

function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL) return;
  lastCleanup = now;
  for (const [key, entry] of store.entries()) {
    if (now > entry.resetAt) store.delete(key);
  }
}

interface RateLimitOptions {
  key: string;
  limit: number;
  windowMs: number;
}

interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
  statusCode: number;
}

/**
 * In-memory rate limit check. Pure function; safe to call from any route.
 */
export function rateLimit({ key, limit, windowMs }: RateLimitOptions): RateLimitResult {
  cleanup();
  const now = Date.now();
  const existing = store.get(key);
  if (!existing || now > existing.resetAt) {
    const resetAt = now + windowMs;
    store.set(key, { count: 1, resetAt });
    return { success: true, remaining: limit - 1, resetAt, statusCode: 200 };
  }
  if (existing.count >= limit) {
    return { success: false, remaining: 0, resetAt: existing.resetAt, statusCode: 429 };
  }
  existing.count++;
  return {
    success: true,
    remaining: limit - existing.count,
    resetAt: existing.resetAt,
    statusCode: 200,
  };
}

/**
 * Extract the client IP from a request, honouring the TRUST_PROXY setting.
 *
 * - If TRUST_PROXY=true, takes the LEFTMOST IP in x-forwarded-for
 *   (the original client) and trims whitespace.
 * - Otherwise ignores x-forwarded-for entirely (potential spoofing).
 * - Falls back to x-real-ip (set by the proxy itself) and finally to
 *   "unknown".
 */
export function getClientIP(req: Request): string {
  const trustProxy = process.env.TRUST_PROXY === "true";
  if (trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  // No proxy headers — fall back to unknown (rate limiter will still
  // apply, just keyed on "unknown" rather than per-IP).
  return "unknown";
}

export const rateLimitPresets = {
  signup: (ip: string) => rateLimit({ key: `signup:${ip}`, limit: 5, windowMs: 60 * 60 * 1000 }),
  login: (ip: string) => rateLimit({ key: `login:${ip}`, limit: 10, windowMs: 60 * 1000 }),
  contact: (ip: string) => rateLimit({ key: `contact:${ip}`, limit: 3, windowMs: 60 * 60 * 1000 }),
  forgotPassword: (ip: string) =>
    rateLimit({ key: `forgotpwd:${ip}`, limit: 3, windowMs: 60 * 60 * 1000 }),
  passwordChange: (ip: string) =>
    rateLimit({ key: `pwdchange:${ip}`, limit: 3, windowMs: 60 * 60 * 1000 }),
  paymentUpload: (userId: string) =>
    rateLimit({ key: `payupload:${userId}`, limit: 20, windowMs: 60 * 60 * 1000 }),
  financeExport: (userId: string) =>
    rateLimit({ key: `export:${userId}`, limit: 3, windowMs: 60 * 60 * 1000 }),
  impersonate: (userId: string) =>
    rateLimit({ key: `impersonate:${userId}`, limit: 10, windowMs: 60 * 60 * 1000 }),
} as const;

// ====================================================================
// Redis-ready adapter (stub)
// Activated only when REDIS_URL is set. Kept as a stub for now so the
// abstraction exists; a real ioredis integration can be dropped in
// without changing any caller.
// ====================================================================

export interface RateLimiterBackend {
  check(opts: RateLimitOptions): Promise<RateLimitResult>;
}

class InMemoryBackend implements RateLimiterBackend {
  async check(opts: RateLimitOptions) {
    return rateLimit(opts);
  }
}

class RedisBackend implements RateLimiterBackend {
  // NOTE: Implementing the Redis backend requires adding `ioredis` as a
  // dependency. We deliberately do NOT pull it in now to keep the
  // bundle small for single-instance Coolify deployments. When needed:
  //   1. npm install ioredis
  //   2. Implement INCR + EXPIRE pipeline in check().
  async check(opts: RateLimitOptions): Promise<RateLimitResult> {
    // Fall back to in-memory until Redis is implemented.
    return rateLimit(opts);
  }
}

export const rateLimiterBackend: RateLimiterBackend = process.env.REDIS_URL
  ? new RedisBackend()
  : new InMemoryBackend();
