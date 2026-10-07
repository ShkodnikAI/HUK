// Fixed-window rate limiter (H-103) backed by Postgres. One atomic upsert
// per call; buckets are cheap to purge (worker wiring arrives with H-104+).

import { db } from "@/server/db";
import { errorBody } from "@/server/http/errors";

export type RateLimitVerdict = {
  ok: boolean;
  remaining: number;
  retryAfterSec: number;
};

function windowStartFor(windowSec: number, nowMs: number): { start: Date; end: number } {
  const nowSec = Math.floor(nowMs / 1000);
  const startSec = Math.floor(nowSec / windowSec) * windowSec;
  return { start: new Date(startSec * 1000), end: (startSec + windowSec) * 1000 };
}

/** Consumes one unit from the bucket and returns the verdict. */
export async function rateLimit(opts: {
  key: string;
  limit: number;
  windowSec: number;
}): Promise<RateLimitVerdict> {
  const nowMs = Date.now();
  const { start, end } = windowStartFor(opts.windowSec, nowMs);

  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitBucket" ("key", "windowStart", "count")
    VALUES (${opts.key}, ${start}, 1)
    ON CONFLICT ("key", "windowStart")
      DO UPDATE SET "count" = "RateLimitBucket"."count" + 1
    RETURNING "count"
  `;

  const count = rows[0]?.count ?? 1;
  return {
    ok: count <= opts.limit,
    remaining: Math.max(0, opts.limit - count),
    retryAfterSec: Math.max(1, Math.ceil((end - nowMs) / 1000)),
  };
}

/** 429 response with the standard Retry-After header. */
export function tooManyRequests(retryAfterSec: number, requestId: string): Response {
  return Response.json(errorBody("RATE_LIMITED", "Too many requests", requestId), {
    status: 429,
    headers: { "retry-after": String(Math.max(1, retryAfterSec)) },
  });
}

/** Deletes buckets whose window has fully passed. Returns the rows removed. */
export async function purgeExpiredBuckets(before: Date = new Date()): Promise<number> {
  const res = await db.rateLimitBucket.deleteMany({ where: { windowStart: { lt: before } } });
  return res.count;
}
