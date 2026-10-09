// GET/HEAD /api/audio/[trackId] (H-112, owner decision D14 amending S3):
// streams the broadcast-cache copy of the track on air — listeners never
// load the author's host. Public read-only route (listed in
// scripts/ci/public-routes.txt with the reason); rate limited per IP hash.
//
// S2/S9 fail closed, one identical plain 404 for every refusal (no oracle):
// unknown id, malformed id, not in the window, not APPROVED, unavailable,
// no cache entry. The file is served only when the track is inside the
// broadcast window (on air, in the 60 s end grace, or among the next five
// slots), APPROVED and available, and the cache holds its moderated bytes.
//
// Range support is required (the player seeks to the shared-timeline
// offset): bytes=a-b, bytes=a-, bytes=-n → 206 with Content-Range;
// invalid or multi-range → 416; no header → 200. ETag is the moderated
// content hash; Content-Type comes from a fixed allowlist decided from the
// file's own bytes — never from the author's server. Streams from disk; no
// whole-file buffering.

import { createReadStream } from "node:fs";
import { openSync, readSync, closeSync, lstatSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import type { PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { route } from "@/server/http/handler";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { CACHE_GRACE_MS, cacheFileName, parseByteRange, sniffAudioType } from "@/server/broadcast/audio-cache";

export const dynamic = "force-dynamic";

// cuid(): 25 lowercase alphanumerics starting with 'c' (Prisma default).
const CUID_RE = /^c[a-z0-9]{24}$/;

/** Generous for ranged playback; per IP hash (H-112 task 5). */
const AUDIO_RATE_LIMIT = { limit: 120, windowSec: 60 } as const;

type Ctx = { params: Promise<{ trackId?: string }> };

type ServableRow = {
  status: string;
  available: boolean;
  provider: string | null;
  contentHash: string | null;
  onAirOrGrace: boolean;
  inNextFive: boolean;
};

/**
 * One query: the track, its source and whether it sits inside the broadcast
 * window (a slot airing or inside the end grace, or among the next five
 * future slots — the same definition the cache uses).
 */
async function servableTrack(trackId: string, nowMs: number, client: Pick<PrismaClient, "$queryRaw"> = db): Promise<ServableRow | null> {
  const now = new Date(nowMs);
  const graceCutoff = new Date(nowMs - CACHE_GRACE_MS);
  const rows = await client.$queryRaw<ServableRow[]>`
    WITH "nextFive" AS (
      SELECT s."trackId"
        FROM "BroadcastSlot" s
        JOIN "Track" t2 ON t2."id" = s."trackId" AND t2."status" = 'APPROVED' AND t2."available" = true
       WHERE s."startsAt" > ${now}
       ORDER BY s."startsAt" ASC
       LIMIT 5
    )
    SELECT t."status"::text AS "status", t."available" AS "available",
           ts."provider"::text AS "provider", ts."contentHash" AS "contentHash",
           EXISTS (SELECT 1 FROM "BroadcastSlot" s
                    WHERE s."trackId" = t."id"
                      AND s."startsAt" <= ${now}
                      AND s."endsAt" > ${graceCutoff}) AS "onAirOrGrace",
           EXISTS (SELECT 1 FROM "nextFive" nf WHERE nf."trackId" = t."id") AS "inNextFive"
      FROM "Track" t
      LEFT JOIN "TrackSource" ts ON ts."trackId" = t."id"
     WHERE t."id" = ${trackId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

function notFound(): Response {
  // The SAME plain 404 for every refusal — no oracle for what exists.
  return new Response("Not Found", { status: 404, headers: { "content-length": "9" } });
}

async function serve(req: Request, rawTrackId: string | undefined, headOnly: boolean): Promise<Response> {
  const env = loadEnv();

  // Identity + per-IP rate limit BEFORE anything else touches the DB.
  const ip = clientIp(req, env);
  const ipHash = ip ? hashIp(ip, new Date(), env) : null;
  if (ipHash) {
    const verdict = await rateLimit({ key: `audio:ip:${ipHash}`, ...AUDIO_RATE_LIMIT });
    if (!verdict.ok) return tooManyRequests(verdict.retryAfterSec, "audio");
  }

  const trackId = typeof rawTrackId === "string" ? rawTrackId : "";
  if (!CUID_RE.test(trackId)) return notFound(); // malformed — never touch the FS

  const nowMs = Date.now();
  const row = await servableTrack(trackId, nowMs);
  const dir = env.AUDIO_CACHE_DIR;
  const servable =
    row !== null &&
    row.status === "APPROVED" &&
    row.available === true &&
    row.provider === "DIRECT_URL" &&
    row.contentHash !== null &&
    (row.onAirOrGrace || row.inNextFive) &&
    dir !== undefined;
  if (!servable) return notFound();

  const path = `${dir}/${cacheFileName(trackId, row.contentHash as string)}`;
  // lstat: a symlink is never served (path-traversal / link attacks fail).
  let size: number;
  try {
    const lst = lstatSync(path);
    if (!lst.isFile()) return notFound();
    size = statSync(path).size;
  } catch {
    return notFound(); // no cache entry — the slot is skipped by the worker (S9)
  }

  const parsed = parseByteRange(req.headers.get("range"), size);
  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}`, "accept-ranges": "bytes", etag: `"${row.contentHash}"` },
    });
  }

  const baseHeaders: Record<string, string> = {
    "accept-ranges": "bytes",
    etag: `"${row.contentHash}"`,
    "cache-control": "private, max-age=300, no-transform",
    "x-content-type-options": "nosniff",
  };

  // Content-Type from the file's own first bytes (fixed allowlist).
  const fd = openSync(path, "r");
  let head: Uint8Array;
  try {
    const buf = Buffer.alloc(16);
    const n = readSync(fd, buf, 0, 16, 0);
    head = new Uint8Array(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  baseHeaders["content-type"] = sniffAudioType(head);

  if (headOnly) {
    if (parsed.kind === "range") baseHeaders["content-range"] = `bytes ${parsed.start}-${parsed.end}/${size}`;
    baseHeaders["content-length"] = String(parsed.kind === "range" ? parsed.end - parsed.start + 1 : size);
    return new Response(null, { status: parsed.kind === "range" ? 206 : 200, headers: baseHeaders });
  }

  if (parsed.kind === "range") {
    const { start, end } = parsed;
    const stream = createReadStream(path, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...baseHeaders, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    });
  }

  const stream = createReadStream(path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: { ...baseHeaders, "content-length": String(size) },
  });
}

export const GET = route<Ctx>(async (req, ctx) => {
  const { trackId } = await ctx.params;
  return serve(req, trackId, false);
});

export const HEAD = route<Ctx>(async (req, ctx) => {
  const { trackId } = await ctx.params;
  return serve(req, trackId, true);
});
