# ====================================================================
# Taswerak — Production Dockerfile (Node 22 + Next.js standalone + Prisma 7)
#
# Hardening:
#   - Multi-stage build. Build stage never has production secrets.
#   - next build is run with NEXT_TELEMETRY_DISABLED=1 and no real secrets.
#   - Runtime image runs as non-root user (nextjs:1001).
#   - prisma migrate deploy runs at startup (CMD) using the runtime DB URL.
#   - /app/.upload is created and chowned so it can be bind-mounted as
#     a persistent volume for local-storage mode.
#   - HEALTHCHECK hits /api/health/ready.
# ====================================================================

# ---------- 1. Base (Node 22 LTS) ----------
FROM node:22-bookworm-slim AS base
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ---------- 2. Install deps ----------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
# --legacy-peer-deps is needed because next-auth@5.0.0-beta declares
# peerOptional nodemailer@^7.0.7 which conflicts with our nodemailer@6.9.15.
RUN npm ci --legacy-peer-deps

# ---------- 3. Build ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# next build needs a DATABASE_URL ONLY if Prisma Client is imported at
# build time (rare). We provide a placeholder so build does not fail;
# it will NOT be used at runtime — the real URL is set at runtime.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder?schema=public"

# Generate Prisma Client, then build Next.js standalone
RUN npx prisma generate
RUN npm run build

# ---------- 4. Production (Node 22 slim, non-root) ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# Set HOME to /app so npx/prisma can write cache files (the nextjs user
# has no home directory by default — HOME would be /nonexistent).
ENV HOME=/app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output (Next.js server + traced node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Copy prisma migrations + schema for `prisma migrate deploy`
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma

# Install ONLY the prisma CLI + pg adapter runtime deps in the runner.
# This is much faster than copying the entire builder node_modules
# (which includes puppeteer's Chromium at ~300MB).
# We use --no-save to avoid modifying package.json, --legacy-peer-deps
# to match the lockfile.
RUN npm install --no-save --legacy-peer-deps --omit=dev \
    prisma@^7.8.0 \
    @prisma/client@^7.8.0 \
    @prisma/adapter-pg@^7.8.0 \
    pg@^8.13.1

# Copy the generated Prisma Client from builder (needed by @prisma/client)
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

# Persistent volume for local-storage mode (ignored when using MinIO)
RUN mkdir -p /app/.upload && chown -R nextjs:nodejs /app/.upload
VOLUME ["/app/.upload"]

# Switch to non-root user
USER nextjs

EXPOSE 3000

# Health check — hits /api/health/ready every 30s, unhealthy after 3 failures
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -fsS http://localhost:3000/api/health/ready || exit 1

# Start: apply migrations THEN start Node.js server
# Use ./node_modules/.bin/prisma instead of npx to avoid npx trying to
# fetch prisma from the registry (which fails when HOME is not writable
# or when the registry is unreachable).
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node server.js"]
