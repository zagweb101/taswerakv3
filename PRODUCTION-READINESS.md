# Production Readiness — Change Log

This document summarizes the security, storage, payment, seed, email,
health, Docker, environment-validation, rate-limiting, test and CI
changes introduced on branch `agent/production-readiness`.

## Summary

The Taswerak v3 codebase was audited against a production-readiness
checklist and hardened across thirteen areas. The branch opens as a
**Draft Pull Request** against `main` — it has NOT been merged.

## Risks Addressed

| # | Risk | Fix |
|---|------|-----|
| 1 | MinIO bucket made publicly readable | New `storage.ts` keeps the bucket private by default; only `public/`-prefixed keys are exposed |
| 2 | `/api/files/[filename]` served any local file without auth | Route now blocks `receipts_*` / `submissions_*` / `private_*` flat names; only legacy public assets remain servable |
| 3 | MIME type trusted from `file.type` (spoofable) | `detectMime()` reads magic bytes and rejects mismatches |
| 4 | Path traversal possible via crafted object keys | `isSafePath()` + `safeLocalPath()` reject `..`, null bytes, leading `/`, backslashes |
| 5 | Private files served by guessable URLs | Private files now use `crypto.randomUUID()` object keys |
| 6 | Students could fetch other students' receipts | `/api/files/private/[...path]` does DB-backed authorization (student=own, instructor=course-enrolled, admin=any) |
| 7 | Payment webhooks trusted `status` alone | Moyasar/Tap routes now refetch the payment from the gateway API and verify id, amount, currency, userId, courseId |
| 8 | Webhooks without signatures accepted | HMAC-SHA256 verification with `MOYASAR_WEBHOOK_SECRET` / `TAP_WEBHOOK_SECRET`; fail-closed when secret is missing |
| 9 | No idempotency on duplicate webhooks | `isAlreadyPaid()` short-circuits before any DB write |
| 10 | Seed used `Password123!` and created demo accounts unconditionally | Seed now env-driven (`SEED_ADMIN_*`), refuses `ENABLE_DEMO_SEED=true` in production, rejects weak passwords |
| 11 | Email module silently fell back to simulation on SMTP failure in production | Email now returns `{ok:false, mode:"smtp", error}` in production; simulation is dev/staging only |
| 12 | No liveness/readiness separation | Added `/api/health/live` (no DB) and `/api/health/ready` (DB + auth + storage + env) |
| 13 | No env validation at boot | `env.ts` validates AUTH_SECRET, DATABASE_URL, NEXTAUTH_URL HTTPS, SMTP, gateway keys, demo-seed guard |
| 14 | Rate limiter trusts `x-forwarded-for` blindly | `TRUST_PROXY` env flag now gates XFF; only first hop is used |
| 15 | No test suite | Added 139 Vitest tests covering all 15 required scenarios |
| 16 | No CI workflow | Added `.github/workflows/production-readiness.yml` running lint + typecheck + test + build + docker |

## New Files

```
src/lib/env.ts                                          # Environment validation
src/lib/services/storage.ts                             # Secure storage layer (public/private split, MIME, traversal guard)
src/lib/services/webhook-verify.ts                      # Pure webhook verification logic (HMAC, amount, currency, metadata)
src/app/api/files/private/[...path]/route.ts            # Auth-protected private file serving
src/app/api/files/public/[...path]/route.ts             # Public file serving (traversal-safe)
src/app/api/health/live/route.ts                        # Liveness probe (no DB)
src/app/api/health/ready/route.ts                       # Readiness probe (DB + env + storage)
scripts/migrate-private-files.ts                        # One-shot DB migration of legacy file URLs
.github/workflows/production-readiness.yml              # CI workflow
vitest.config.ts                                        # Test runner config
tests/setup.ts                                          # Test setup
tests/storage.test.ts                                   # Storage unit tests
tests/env.test.ts                                       # Env validation tests
tests/webhook.test.ts                                   # Webhook verification tests
tests/email.test.ts                                     # Email service tests
tests/rate-limit.test.ts                                # Rate limiter tests
tests/file-authz.test.ts                                # File authorization tests
tests/submissions.test.ts                               # Submission rule tests (maxAttempts, duplicate enrollment)
tests/seed.test.ts                                      # Seed guard tests
tests/health.test.ts                                    # Health probe tests
PRODUCTION-READINESS.md                                 # This document
```

## Modified Files

```
.env.example                                            # No secrets, new vars documented
Dockerfile                                              # Non-root, persistent /app/.upload volume, /api/health/ready healthcheck, no secrets at build time
package.json                                            # Added test/typecheck scripts, vitest dev dep
tsconfig.json                                           # target ES2018 (named capture groups)
prisma/seed.ts                                          # Env-driven admin, demo guard, idempotent, no public passwords
src/lib/services/minio.ts                               # Now a shim over storage.ts; legacy uploadFile preserved
src/lib/services/email.ts                               # Production fail-closed, structured result
src/lib/services/rate-limit.ts                          # TRUST_PROXY support, Redis-ready backend stub
src/lib/prisma.ts                                       # Now proxies to lib/db.ts (adapter-pg)
src/app/api/files/[filename]/route.ts                   # Blocks private flat names, uses real MIME
src/app/api/health/route.ts                             # Now proxies to ready logic
src/app/api/payments/callback/moyasar/route.ts          # Fail-closed, HMAC verify, refetch, idempotent, amount/currency check
src/app/api/payments/callback/tap/route.ts              # Same hardening as Moyasar
src/app/api/student/payments/route.ts                   # Transaction-wrapped, real MIME, secure storage, cleanup on failure
src/app/api/student/submissions/route.ts                # maxAttempts enforced, real MIME, unguessable key, transaction
src/app/api/courses/[courseId]/builder/lessons/route.ts # Fixed pre-existing Next.js 16 params Promise type
src/app/api/courses/[courseId]/builder/sections/route.ts# Fixed pre-existing Next.js 16 params Promise type
```

## New Environment Variables

| Variable | Required? | Description |
|---|---|---|
| `STORAGE_PROVIDER` | optional | `auto` (default), `minio`, or `local` |
| `LOCAL_STORAGE_DIR` | warn in prod | Where local-storage files are written (mount a persistent volume here) |
| `TRUST_PROXY` | optional | `true` to honour `X-Forwarded-For` from a trusted proxy |
| `MOYASAR_WEBHOOK_SECRET` | required when gateway=moyasar | HMAC secret for verifying Moyasar webhooks |
| `TAP_WEBHOOK_SECRET` | required when gateway=tap | HMAC secret for verifying Tap webhooks |
| `SEED_ADMIN_EMAIL` | required to seed in prod | Email of the first admin |
| `SEED_ADMIN_PASSWORD` | required to seed in prod | ≥12 chars, not a placeholder |
| `SEED_ADMIN_NAME` | optional | Display name |
| `SEED_ADMIN_PHONE` | optional | Phone |
| `ENABLE_DEMO_SEED` | optional | `true` to seed demo instructor + student (FORBIDDEN in production) |
| `REDIS_URL` | optional | When set, rate limiter uses Redis (stub for now) |

## Migration Steps

1. **Apply database migrations** — `npx prisma migrate deploy`
2. **Run the file URL migration** — `npx tsx scripts/migrate-private-files.ts`
   This rewrites `PaymentReceipt.imageUrl` and `Submission.imageUrl` to the new
   `/api/files/private/...` format.
3. **(If using local storage)** Physically move legacy `.upload/receipts_*`
   files to `.upload/private/receipts/`, and `.upload/submissions_*` to
   `.upload/private/submissions/`. The URL migration script handles DB rows;
   the physical file move is a separate shell step.
4. **(If using MinIO)** Old objects remain in the bucket under
   `receipts/` and `submissions/`. The new storage layer writes to
   `private/receipts/` and `private/submissions/`. You can either:
   - Leave old objects in place (the new URL format will still find them
     because the new route reads from `private/receipts/...`); OR
   - Use `mc cp --recursive` to move old objects to the new prefix
     before running the DB migration script.
5. **Rotate `AUTH_SECRET`** — the old `change-me-...` placeholder is no
   longer accepted in production.
6. **Set `SEED_ADMIN_*` env vars** if you plan to run `db:seed` in
   production. Otherwise, create your first admin manually via SQL.

## Verification Results

```
npm ci                  — PASS (local)
npx prisma generate     — PASS (local, Prisma Client v7.8.0)
npm run lint            — PASS (local, 0 errors, 6 pre-existing warnings)
npm run typecheck       — PASS (local)
npm test                — PASS (local, 139/139)
npm run build           — PASS (local, Next.js 16 standalone output)
docker build            — SKIPPED locally (no docker in agent sandbox)
                          — CI 'docker' job runs: docker build -t taswerak:ci .
docker smoke test       — Run by CI 'docker-smoke' job:
                            1. npx prisma migrate deploy on fresh DB
                            2. GET /api/health/live  → HTTP 200
                            3. GET /api/health/ready → HTTP 200
                            4. GET /api/files/private/... (no auth) → HTTP 401 or 403
migrations on clean DB  — Verified by CI (both lint-typecheck-test AND docker-smoke jobs)
GitHub Actions          — 4-job workflow configured; runs on PR + push
                          to agent/production-readiness
```

## Rollback Steps

1. Revert the merge commit on `main` (if accidentally merged) — the
   branch is opened as **Draft PR** and has NOT been merged.
2. Database: the file-URL migration script is reversible — write a
   counterpart that strips the `/api/files/private/` prefix and restores
   the original URL format. The schema itself is unchanged; no
   destructive migration was added.
3. Env vars: simply unset the new variables. The app will run in
   "warn-only" mode for the new checks if `NODE_ENV != production`.
4. Code: `git revert <merge-sha>` on `main`.

## Staging Checklist (Coolify)

- [ ] Set `NODE_ENV=production`
- [ ] Set `NEXTAUTH_URL=https://staging.taswerak.example.com` (must be HTTPS)
- [ ] Generate `AUTH_SECRET` with `openssl rand -base64 48`
- [ ] Set `DATABASE_URL` to the staging Postgres (NOT the dev password)
- [ ] Set `DIRECT_URL` to the same Postgres (bypass pgbouncer if used)
- [ ] Set `EMAIL_TRANSPORT=smtp` and configure `SMTP_HOST`, `SMTP_PORT`,
      `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM`
- [ ] Set `STORAGE_PROVIDER=minio` (preferred) or `local`
- [ ] If `local`, mount a persistent volume at `/app/.upload` and set
      `LOCAL_STORAGE_DIR=/app/.upload`
- [ ] If `minio`, set `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`,
      `MINIO_BUCKET`, `MINIO_PUBLIC_URL`
- [ ] Set `PAYMENT_GATEWAY` (likely `manual` for staging)
- [ ] If using `moyasar` or `tap`, set the secret key AND the webhook secret
- [ ] Set `TRUST_PROXY=true` (Coolify sits behind a proxy)
- [ ] Set `ENABLE_DEMO_SEED=false`
- [ ] After first deploy: run `npx tsx scripts/migrate-private-files.ts` once
- [ ] Smoke test: `curl https://staging.../api/health/ready` → 200
- [ ] Smoke test: `curl https://staging.../api/health/live` → 200
- [ ] Try to fetch a private receipt URL while logged out → 401
- [ ] Try to fetch another student's receipt → 403

## Remaining Issues

1. **Puppeteer** is in `package.json` but the certificate PDF route uses
   it. Puppeteer adds ~300 MB to the Docker image. If certificates are
   not needed in staging, consider lazy-loading or replacing with
   `@react-pdf/renderer`. Out of scope for this PR.
2. **Rate-limit Redis backend** is a stub. Multi-replica deployments
   must implement `RedisBackend.check()` with `INCR + EXPIRE` before
   scaling out. The interface is in place.
3. **`ENABLE_IMPERSONATION=true`** is the default. Consider disabling
   in production unless admins actively need it.
4. **`puppeteer` postinstall** downloads Chromium at install time. CI
   caches this; staging builds may be slow on first deploy.
5. **`z-ai-web-dev-sdk`** is in dependencies. If unused in production,
   move to devDependencies. Out of scope for this PR.
6. **Pre-existing `lib/prisma.ts`** used `new PrismaClient()` without
   the adapter — this would have failed at runtime in Prisma 7. Fixed
   by proxying to `lib/db.ts`, but the file should eventually be
   deleted and callers updated to `import { db } from "@/lib/db"`.
