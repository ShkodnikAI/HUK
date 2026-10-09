// Broadcast audio cache (H-112, owner decision D14 amending invariant S3).
// The ONLY module besides the moderation temp download that may persist
// user audio to disk (CI: scripts/ci/audio-store.mjs, invariant `audio-store`).
//
// Why (D14, 2026-10-09): listeners must never load authors' hosts. The worker
// keeps a private copy of the audio for the slot on air plus the next five
// slots (a 60 s grace after a slot ends covers clients still finishing) and
// GET /api/audio/[trackId] streams the copy instead. Only APPROVED, available
// DIRECT_URL tracks whose bytes hash to the moderated TrackSource.contentHash
// are ever written. The directory is private (0700, files 0600), outside every
// served path (validated in src/server/env.ts), entries are deleted when the
// slot ends plus grace, the track leaves the window, loses availability, is
// taken down or retired (purge called from retireTrackFromAir), and any stray
// is swept when the worker starts. A cache miss NEVER falls back to streaming
// from the author's URL — the slot is skipped instead (S9, fail closed).
//
// Failure economics: a track inside the window is fetched ONCE per backoff
// attempt (15 s, 1 min, 3 min, 6 min after it enters the window). Transport
// failures (author host off, timeout, 4xx/5xx) say nothing bad about the
// content: they retry on the schedule and never touch TrackSource.failCount
// per attempt. One whole failed series counts as a SINGLE failure towards
// SOURCE_MAX_FAILS, sets TrackSource.cacheRetryAfter (+30 min cool-down the
// scheduler respects) and replaces the track's window slots at once — the
// scheduler refills the hole from other candidates in the same tick. A hash
// mismatch is a content crime, not a transport failure: the bytes are not
// kept and the exact source-suspension path (suspend, retire, re-moderation)
// runs, as in src/server/sources/verify.ts. When the cache is full nothing is
// fetched and nothing in the window is ever evicted — the refusal is loud.

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadEnv, type Env } from "@/server/env";
import { db as defaultDb } from "@/server/db";
import { audit } from "@/server/audit";
import { safeFetch, type SafeLoader, type SafeResolver } from "@/server/net/safe-fetch";
import { retireTrackFromAir } from "./retire";

/** Grace after a slot ends during which the cached copy is still served. */
export const CACHE_GRACE_MS = 60_000;

/** Same moderation download cap (S6-adjacent bound, verify.ts). */
export const FETCH_CAP_BYTES = 512 * 1024 * 1024;

/** Backoff attempts after the track enters the window (H-112 task 3). */
export const BACKOFF_SCHEDULE_MS = [15_000, 60_000, 180_000, 360_000] as const;

/** Cool-down recorded in TrackSource.cacheRetryAfter after a failed series. */
export const CACHE_COOLDOWN_MS = 30 * 60_000;

const FILE_SUFFIX = ".cache";
const HASH_PREFIX_LEN = 12;

export type AudioCacheSeam = {
  client?: PrismaClient;
  env?: Pick<Env, "AUDIO_CACHE_DIR" | "AUDIO_CACHE_MAX_BYTES" | "SOURCE_MAX_FAILS">;
  loader?: SafeLoader;
  resolver?: SafeResolver;
  portAllowlist?: number[];
  now?: () => number;
  /** Test override for the cache directory (defaults to env.AUDIO_CACHE_DIR). */
  dir?: string;
};

/**
 * Per-track backoff series state. In-memory by design: the worker is a single
 * leader process; after a restart the series restarts (bounded by the
 * persisted cacheRetryAfter cool-down once a series actually fails).
 */
export type AudioCacheState = Map<string, { enteredAt: number; attempts: number }>;

export function makeAudioCacheState(): AudioCacheState {
  return new Map();
}

const defaultState: AudioCacheState = makeAudioCacheState();

// ───────────────── pure helpers (unit-tested) ─────────────────

/** Cache file name — derived from the track id and the moderated hash ONLY. */
export function cacheFileName(trackId: string, contentHash: string): string {
  return `${trackId}.${contentHash.slice(0, HASH_PREFIX_LEN)}${FILE_SUFFIX}`;
}

/** Track id encoded in a cache file name, or null for a foreign name. */
export function trackIdFromFileName(name: string): string | null {
  if (!name.endsWith(FILE_SUFFIX)) return null;
  const dot = name.indexOf(".");
  if (dot <= 0) return null;
  return name.slice(0, dot);
}

const AUDIO_TYPES: Array<{ test: (h: Uint8Array) => boolean; type: string }> = [
  { test: (h) => h.length >= 3 && h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33, type: "audio/mpeg" },
  // MPEG frame sync (no ID3 tag): 11 set bits after the first byte.
  { test: (h) => h.length >= 2 && h[0] === 0xff && (h[1] & 0xe0) === 0xe0, type: "audio/mpeg" },
  { test: (h) => h.length >= 12 && h[0] === 0x52 && h[1] === 0x49 && h[2] === 0x46 && h[3] === 0x46 && h[8] === 0x57 && h[9] === 0x41 && h[10] === 0x56 && h[11] === 0x45, type: "audio/wav" },
  { test: (h) => h.length >= 4 && h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53, type: "audio/ogg" },
  { test: (h) => h.length >= 8 && h[4] === 0x66 && h[5] === 0x74 && h[6] === 0x79 && h[7] === 0x70, type: "audio/mp4" },
];

/**
 * Content-Type from a FIXED allowlist, decided from the file's own bytes —
 * never from the author's server headers (H-112 task 5). Moderation only
 * accepts mp3/wav/ogg/m4a, so the octet-stream fallback is a defensive
 * default, not a serving path.
 */
export function sniffAudioType(head: Uint8Array): string {
  for (const t of AUDIO_TYPES) if (t.test(head)) return t.type;
  return "application/octet-stream";
}

export type ByteRange =
  | { kind: "full" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

/**
 * Parses a single `bytes=` Range header against a file of `size` bytes.
 * `bytes=a-b`, `bytes=a-`, `bytes=-n` → range; no header → full; malformed,
 * multi-range ("a-b,c-d"), a > b, a >= size or n = 0 → unsatisfiable (416).
 */
export function parseByteRange(header: string | null, size: number): ByteRange {
  if (header === null) return { kind: "full" };
  if (!header.startsWith("bytes=") || header.includes(",")) return { kind: "unsatisfiable" };
  const spec = header.slice("bytes=".length);
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return { kind: "unsatisfiable" };
  const [, aRaw, bRaw] = m;
  if (aRaw === "" && bRaw === "") return { kind: "unsatisfiable" };
  if (aRaw === "") {
    // suffix: last n bytes; n = 0 is unsatisfiable; n > size → whole file.
    const n = Number(bRaw);
    if (!Number.isInteger(n) || n <= 0) return { kind: "unsatisfiable" };
    const start = Math.max(0, size - n);
    return { kind: "range", start, end: size - 1 };
  }
  const start = Number(aRaw);
  if (!Number.isInteger(start) || start >= size) return { kind: "unsatisfiable" };
  const end = bRaw === "" ? size - 1 : Math.min(Number(bRaw), size - 1);
  if (!Number.isInteger(end) || end < start) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

// ───────────────── the broadcast window (one query) ─────────────────

export type CacheWindow = {
  /** Track ids with a slot airing right now or inside the end grace. */
  onAir: string[];
  /** Track ids of the next five future slots (the /now window). */
  upcoming: string[];
  /** Tracks with a slot airing strictly between startsAt and endsAt. */
  liveNow: string[];
  /** Union of onAir and upcoming — the tracks that may hold a cache entry. */
  tracks: string[];
};

type WindowRow = { trackId: string; startsAt: Date; endsAt: Date };

/**
 * The cache window in one query: every APPROVED, available DIRECT_URL slot
 * still inside the end grace, plus the next five future slots. Same
 * definition as /now (current + NEXT_LIMIT), plus the 60 s grace. Used by the
 * cache pass (it must know which slots are strictly live to skip uncached
 * ones) and by the boot sweep.
 */
export async function broadcastWindow(
  nowMs: number,
  client: Pick<PrismaClient, "$queryRaw"> = defaultDb,
): Promise<CacheWindow & { slots: Array<{ trackId: string; startsAt: number; endsAt: number }> }> {
  const graceCutoff = new Date(nowMs - CACHE_GRACE_MS);
  const rows = await client.$queryRaw<WindowRow[]>`
    SELECT s."trackId", s."startsAt", s."endsAt"
      FROM "BroadcastSlot" s
      JOIN "Track" t ON t."id" = s."trackId" AND t."status" = 'APPROVED' AND t."available" = true
      JOIN "TrackSource" ts ON ts."trackId" = t."id" AND ts."provider" = 'DIRECT_URL'
     WHERE s."endsAt" > ${graceCutoff}
     ORDER BY s."startsAt" ASC
  `;
  const slots = rows.map((r) => ({ trackId: r.trackId, startsAt: r.startsAt.getTime(), endsAt: r.endsAt.getTime() }));
  const onAir: string[] = [];
  const upcoming: string[] = [];
  const liveNow: string[] = [];
  for (const s of slots) {
    if (s.startsAt <= nowMs) {
      if (!onAir.includes(s.trackId)) onAir.push(s.trackId);
      if (s.endsAt > nowMs && !liveNow.includes(s.trackId)) liveNow.push(s.trackId);
    } else if (upcoming.length < 5 && !upcoming.includes(s.trackId)) {
      upcoming.push(s.trackId);
    }
  }
  return { onAir, upcoming, liveNow, tracks: [...onAir, ...upcoming], slots };
}

// ───────────────── disk primitives (this file is the audio-store allowlist) ─────────────────

function ensureCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function dirTotalBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) total += st.size;
    } catch {
      /* raced away */
    }
  }
  return total;
}

/**
 * Removes every cache entry of `trackId` (any hash). Called from
 * retireTrackFromAir so a takedown removes the copy immediately (D14/S3),
 * and used for stale-hash cleanup inside the pass. No dir configured →
 * nothing was ever persisted → no-op.
 */
export function purgeTrackFromCache(trackId: string, dir?: string): number {
  const cacheDir = dir ?? loadEnv().AUDIO_CACHE_DIR;
  if (!cacheDir) return 0;
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith(`${trackId}.`) || !name.endsWith(FILE_SUFFIX)) continue;
    try {
      rmSync(join(cacheDir, name), { force: true });
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

function writeCacheEntry(dir: string, trackId: string, contentHash: string, body: Uint8Array): string {
  const fileName = cacheFileName(trackId, contentHash);
  const finalPath = join(dir, fileName);
  // Atomic write: temp name in the SAME directory, 0600, then rename (S3).
  const tmpPath = join(dir, `.${fileName}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  writeFileSync(tmpPath, body, { mode: 0o600 });
  renameSync(tmpPath, finalPath);
  return finalPath;
}

// ───────────────── fetch + verify one track ─────────────────

export type CacheFetchOutcome =
  | { outcome: "cached"; path: string; bytes: number }
  | { outcome: "mismatch"; detail: string }
  | { outcome: "transport-failed"; message: string }
  | { outcome: "permanent-failed"; message: string }
  | { outcome: "cache-full"; detail: string };

const isTransportFailure = (e: unknown): boolean => {
  const code = (e as { code?: string }).code;
  const name = (e as { name?: string }).name;
  if (name === "SafeFetchError") {
    const c = String(code ?? "");
    // Everything except the "the request itself was wrong" classes retries:
    // author-host outages, timeouts and 4xx/5xx are transport noise (BAD_RESPONSE).
    return !["BODY_TOO_LARGE", "INVALID_URL", "INSECURE_TRANSPORT", "USERINFO_FORBIDDEN", "PORT_FORBIDDEN", "HOST_FORBIDDEN", "TOO_MANY_REDIRECTS", "REDIRECT_LOOP"].includes(c);
  }
  return (
    typeof code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPROTO|ECONNABORTED|EPIPE)$/.test(code)
  );
};

async function fetchAndCache(
  trackId: string,
  seam: AudioCacheSeam & { dir: string; maxBytes: number },
): Promise<CacheFetchOutcome> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? Date.now;
  const track = await client.track.findUnique({ where: { id: trackId }, include: { source: true } });
  const source = track?.source;
  if (!track || !source || track.status !== "APPROVED" || !track.available) {
    return { outcome: "permanent-failed", message: `track ${trackId} is not cacheable (status/availability)` };
  }
  if (source.provider !== "DIRECT_URL" || !source.contentHash) {
    // AUDIUS is never cached (D3 open) and SEED is already ours; a DIRECT_URL
    // source without a moderated hash cannot be verified → fail closed.
    return { outcome: "permanent-failed", message: `track ${trackId}: provider ${source.provider}, hash ${source.contentHash ? "present" : "missing"}` };
  }

  // Pre-check the cap from the recorded byte length — refuse BEFORE fetching.
  const recordedBytes = source.byteLength !== null ? Number(source.byteLength) : null;
  const used = dirTotalBytes(seam.dir);
  if (recordedBytes !== null && used + recordedBytes > seam.maxBytes) {
    return { outcome: "cache-full", detail: `cache at ${used} B; ${trackId} needs ${recordedBytes} B (cap ${seam.maxBytes} B)` };
  }

  const res = await safeFetch(source.url, {
    method: "GET",
    maxBytes: seam.maxBytes,
    loader: seam.loader,
    resolver: seam.resolver,
    portAllowlist: seam.portAllowlist,
    totalTimeoutMs: 60_000,
  });
  const body = res.body ?? new Uint8Array();
  const sha256 = createHash("sha256").update(body).digest("hex");

  if (sha256 !== source.contentHash) {
    // Content crime: the bytes are NOT kept. Exact source-suspension path.
    const detail = `broadcast cache hash mismatch: expected ${source.contentHash}, got ${sha256}`;
    await client.$transaction([
      client.track.update({ where: { id: trackId }, data: { status: "SUSPENDED" } }),
      client.moderationRun.create({
        data: {
          trackId,
          stage: "TECHNICAL",
          verdict: "REVIEW",
          payload: { note: "broadcast cache hash mismatch", detail },
        },
      }),
    ]);
    await retireTrackFromAir(trackId, new Date(now()), client);
    await audit({
      actorKind: "worker",
      action: "source.mismatch",
      targetType: "Track",
      targetId: trackId,
      payload: { detail },
    });
    return { outcome: "mismatch", detail };
  }

  if (used + body.byteLength > seam.maxBytes) {
    return { outcome: "cache-full", detail: `cache at ${used} B; ${trackId} brought ${body.byteLength} B (cap ${seam.maxBytes} B)` };
  }

  const path = writeCacheEntry(seam.dir, trackId, source.contentHash, body);
  return { outcome: "cached", path, bytes: body.byteLength };
}

// ───────────────── the pass (leader-only, every 15 s) ─────────────────

export type CachePassSummary = {
  skipped?: string;
  evicted: number;
  fetched: number;
  failedSeries: number;
  mismatched: number;
  cacheFull: number;
  pending: number;
  skippedSlots: number;
};

/**
 * One cache pass. Leader-only by wiring (worker/index.ts gates on the
 * broadcast advisory lock, as for the scheduler). Never throws for
 * track-level conditions — every failure is counted and logged; DB errors
 * propagate to the caller's catch.
 */
export async function runAudioCachePass(
  seam: AudioCacheSeam = {},
  state: AudioCacheState = defaultState,
): Promise<CachePassSummary> {
  const env = seam.env ?? loadEnv();
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? Date.now;
  const nowMs = now();
  const dir = seam.dir ?? env.AUDIO_CACHE_DIR;
  const summary: CachePassSummary = { evicted: 0, fetched: 0, failedSeries: 0, mismatched: 0, cacheFull: 0, pending: 0, skippedSlots: 0 };
  if (!dir) {
    summary.skipped = "AUDIO_CACHE_DIR is not set — the broadcast cache is disabled here";
    return summary;
  }
  ensureCacheDir(dir);

  const win = await broadcastWindow(nowMs, client);
  const expectedNames = new Map<string, string>();
  for (const trackId of win.tracks) {
    const track = await client.track.findUnique({ where: { id: trackId }, include: { source: true } });
    if (track?.source?.contentHash) expectedNames.set(trackId, cacheFileName(trackId, track.source.contentHash));
  }

  // 1. Eviction: anything whose track left the window, changed its hash or
  //    is not a `.cache` file of an in-window track. In-window entries are
  //    NEVER evicted for space (only the cap refusal protects the cap).
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue; // tmp of an in-flight write
    const trackId = trackIdFromFileName(name);
    if (trackId && win.tracks.includes(trackId) && expectedNames.get(trackId) === name) continue;
    try {
      rmSync(join(dir, name), { force: true, recursive: true });
      summary.evicted++;
    } catch {
      /* raced away */
    }
  }

  // 2. Fetch loop for uncached in-window tracks (backoff series per track).
  const cachedNames = new Set(readdirSync(dir));
  for (const trackId of win.tracks) {
    const expected = expectedNames.get(trackId);
    if (!expected) continue; // unresolvable source — nothing to do this pass
    if (cachedNames.has(expected)) continue;

    const source = (await client.track.findUnique({
      where: { id: trackId },
      select: { source: { select: { cacheRetryAfter: true } } },
    }))?.source;
    const retryAfter = source?.cacheRetryAfter;
    if (retryAfter && retryAfter.getTime() > nowMs) continue; // cool-down

    let st = state.get(trackId);
    if (!st) {
      // enteredAt: the earliest window moment that made this track ours —
      // the first slot of the track in the window (started or upcoming).
      const first = win.slots.filter((s) => s.trackId === trackId).map((s) => s.startsAt).sort((a, b) => a - b)[0];
      st = { enteredAt: Math.min(first ?? nowMs, nowMs), attempts: 0 };
      state.set(trackId, st);
    }
    if (st.attempts >= BACKOFF_SCHEDULE_MS.length) continue; // series handled below
    const dueAt = st.enteredAt + BACKOFF_SCHEDULE_MS[st.attempts];
    if (nowMs < dueAt) {
      summary.pending++;
      continue;
    }

    st.attempts++;
    let outcome: CacheFetchOutcome;
    try {
      outcome = await fetchAndCache(trackId, { ...seam, dir, maxBytes: env.AUDIO_CACHE_MAX_BYTES });
    } catch (e) {
      outcome = isTransportFailure(e)
        ? { outcome: "transport-failed", message: e instanceof Error ? e.message : String(e) }
        : { outcome: "permanent-failed", message: e instanceof Error ? e.message : String(e) };
    }

    if (outcome.outcome === "cached") {
      summary.fetched++;
      state.delete(trackId);
      cachedNames.add(expected); // the slot-skip check below sees the fresh copy
      continue;
    }
    if (outcome.outcome === "mismatch") {
      summary.mismatched++;
      state.delete(trackId);
      continue;
    }
    if (outcome.outcome === "cache-full") {
      // Our-side condition: loud, no attempt consumed, retried next pass.
      summary.cacheFull++;
      st.attempts--; // the attempt was not consumed — the cap refused it
      console.error(`[audio-cache] CACHE FULL (AUDIO_CACHE_MAX_BYTES=${env.AUDIO_CACHE_MAX_BYTES}): ${outcome.detail}`);
      continue;
    }

    const seriesDone =
      outcome.outcome === "permanent-failed" || st.attempts >= BACKOFF_SCHEDULE_MS.length;
    if (!seriesDone) {
      console.warn(`[audio-cache] ${trackId}: attempt ${st.attempts}/${BACKOFF_SCHEDULE_MS.length} failed (${outcome.outcome === "transport-failed" ? outcome.message : outcome.message})`);
      continue;
    }
    // 3. The whole series failed — one single failure towards SOURCE_MAX_FAILS.
    state.delete(trackId);
    summary.failedSeries++;
    await failSeries(trackId, outcome.message, nowMs, client, env);
  }

  // 4. S9 fail closed: a slot airing RIGHT NOW without cached audio is
  //    skipped — no fallback to the author's URL, ever. The scheduler fills
  //    the hole from other candidates in the same tick.
  for (const trackId of win.liveNow) {
    const expected = expectedNames.get(trackId);
    if (expected && cachedNames.has(expected)) continue;
    const ended = await client.broadcastSlot.updateMany({
      where: { trackId, startsAt: { lte: new Date(nowMs) }, endsAt: { gt: new Date(nowMs) } },
      data: { endsAt: new Date(nowMs) },
    });
    if (ended.count > 0) {
      summary.skippedSlots++;
      console.error(`[audio-cache] SKIP slot: track ${trackId} is on air without cached audio (S9, fail closed)`);
    }
  }

  return summary;
}

/** One failed series = one failure towards SOURCE_MAX_FAILS + cool-down. */
async function failSeries(
  trackId: string,
  message: string,
  nowMs: number,
  client: PrismaClient,
  env: Pick<Env, "SOURCE_MAX_FAILS">,
): Promise<void> {
  const source = await client.trackSource.findUnique({ where: { trackId } });
  if (!source) return;
  const failCount = source.failCount + 1;
  const cooldownUntil = new Date(nowMs + CACHE_COOLDOWN_MS);
  await client.trackSource.update({
    where: { id: source.id },
    data: { failCount, cacheRetryAfter: cooldownUntil, lastError: `cache series failed: ${message.slice(0, 400)}` },
  });
  // Replace the window slots at once: delete the FUTURE slots of this track
  // only (the track stays available); the scheduler refills from other
  // candidates in the same tick. A live uncached slot is skipped in step 4.
  await client.broadcastSlot.deleteMany({ where: { trackId, startsAt: { gt: new Date(nowMs) } } });
  console.warn(`[audio-cache] series failed for ${trackId}: failCount=${failCount}/${env.SOURCE_MAX_FAILS}, cool-down until ${cooldownUntil.toISOString()}`);
  if (failCount >= env.SOURCE_MAX_FAILS) {
    await client.track.update({ where: { id: trackId }, data: { available: false } });
    await retireTrackFromAir(trackId, new Date(nowMs), client);
    await audit({
      actorKind: "worker",
      action: "source.unavailable",
      targetType: "Track",
      targetId: trackId,
      payload: { failCount, lastError: message.slice(0, 200) },
    });
  }
}

// ───────────────── boot sweep ─────────────────

/**
 * Worker-start sweep (S3 style, mirrors sweepStaleTempFiles): the worker is
 * the only writer and was down — anything on disk that is not in the CURRENT
 * window is deleted. Files of in-window tracks survive a restart.
 */
export async function sweepCacheAtStartAsync(seam: AudioCacheSeam = {}): Promise<number> {
  const env = seam.env ?? loadEnv();
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? Date.now;
  const dir = seam.dir ?? env.AUDIO_CACHE_DIR;
  if (!dir) return 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;
  const win = await broadcastWindow(now(), client);
  let removed = 0;
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const trackId = trackIdFromFileName(name);
    if (trackId && win.tracks.includes(trackId)) continue;
    try {
      rmSync(join(dir, name), { force: true, recursive: true });
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}
