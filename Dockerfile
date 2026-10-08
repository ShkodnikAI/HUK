# syntax=docker/dockerfile:1
# HUK — multi-stage image. Two targets:
#   web    (Next.js server, runs migrations then `next start`)
#   worker (single-writer process: scheduler/queues arrive in H-104+)
# No secrets are baked in: everything arrives via environment at runtime (S8).

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

FROM oven/bun:1 AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

# Non-root runtime (H-108): both runtime stages run as the `bun` user that the
# oven/bun base images provide (uid 1000 / gid 1000, home /home/bun — verified
# in oven-sh/bun `dockerhub/debian{,-slim}/Dockerfile`; the images do NOT set
# USER themselves, so without this the containers run as root). Application
# files are copied with bun ownership; /app itself stays root-owned, and only
# paths the app writes (`.next/cache`, bun caches under $HOME) are bun-writable.
# `prisma migrate deploy` needs no local writes and no root: it reads the
# migrations and applies them to Postgres over DATABASE_URL.

FROM oven/bun:1-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=builder --chown=bun:bun /app/.next ./.next
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/public ./public
COPY --from=builder --chown=bun:bun /app/prisma ./prisma
COPY --chown=bun:bun package.json next.config.ts tsconfig.json components.json ./
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "start"]

FROM oven/bun:1-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
# H-204: the moderation technical stage needs ffprobe/ffmpeg. Worker image
# only — the web image stays minimal (attack surface, image size).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/prisma ./prisma
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src/worker ./src/worker
COPY --chown=bun:bun src/server ./src/server
# H-204: the policy loader reads this at start-up and fails loud when
# missing (S9); the file also pins the policyVersion hashed into runs.
COPY --chown=bun:bun policy ./policy
USER bun
CMD ["bun", "run", "worker"]
