// H-112 — broadcast audio cache (D14/S3): pure helpers, the cache pass
// (backoff series, hash mismatch, cool-down), eviction paths, the boot sweep
// and the public /api/audio/[trackId] route (ranges, identical 404, HEAD,
// symlink refusal). DB suites run in CI (real Postgres); pure suites run
// everywhere.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { databaseUrl, makeClient, cleanTables, skipMessage } from "../db/helpers";
import {
  CACHE_COOLDOWN_MS,
  CACHE_GRACE_MS,
  cacheFileName,
  makeAudioCacheState,
  parseByteRange,
  purgeTrackFromCache,
  runAudioCachePass,
  sniffAudioType,
  sweepCacheAtStartAsync,
  trackIdFromFileName,
  type AudioCacheSeam,
} from "@/server/broadcast/audio-cache";
import { radioNow } from "@/app/api/radio/now/route";
import { GET as audioGET, HEAD as audioHEAD } from "@/app/api/audio/[trackId]/route";
import { retireTrackFromAir } from "@/server/broadcast/retire";
import type { SafeLoader } from "@/server/net/safe-fetch";
import type { PrismaClient } from "@prisma/client";

process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";

if (!databaseUrl) console.log(skipMessage());

// ───────────────── pure helpers (no DB) ─────────────────

describe("audio-cache pure helpers (H-112)", () => {
  it("cacheFileName derives from track id + hash only, roundtrips through trackIdFromFileName", () => {
    const id = "c1234567890123456789012345";
    const name = cacheFileName(id, "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899");
    expect(name).toBe("c1234567890123456789012345.aabbccddeeff.cache");
    expect(trackIdFromFileName(name)).toBe(id);
    expect(trackIdFromFileName("notes.txt")).toBeNull();
    expect(trackIdFromFileName(".hidden.cache")).toBeNull();
  });

  it("sniffAudioType uses a fixed allowlist decided from the file's bytes", () => {
    const mp3id3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]);
    const mp3sync = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
    const m4a = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    expect(sniffAudioType(mp3id3)).toBe("audio/mpeg");
    expect(sniffAudioType(mp3sync)).toBe("audio/mpeg");
    expect(sniffAudioType(wav)).toBe("audio/wav");
    expect(sniffAudioType(ogg)).toBe("audio/ogg");
    expect(sniffAudioType(m4a)).toBe("audio/mp4");
    expect(sniffAudioType(new Uint8Array([1, 2, 3, 4]))).toBe("application/octet-stream");
    expect(sniffAudioType(new Uint8Array())).toBe("application/octet-stream");
  });

  it("parseByteRange: a-b, a-, -n, full, and every refusal shape", () => {
    const size = 1000;
    expect(parseByteRange(null, size)).toEqual({ kind: "full" });
    expect(parseByteRange("bytes=0-99", size)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseByteRange("bytes=100-", size)).toEqual({ kind: "range", start: 100, end: 999 });
    expect(parseByteRange("bytes=-100", size)).toEqual({ kind: "range", start: 900, end: 999 });
    // suffix longer than the file → whole file
    expect(parseByteRange("bytes=-5000", size)).toEqual({ kind: "range", start: 0, end: 999 });
    // end beyond size is clamped
    expect(parseByteRange("bytes=900-5000", size)).toEqual({ kind: "range", start: 900, end: 999 });
    // refusals → unsatisfiable (416)
    for (const bad of ["bytes=", "bytes=500-400", "bytes=1000-", "bytes=-0", "bytes=0-9,20-29", "bytes=abc", "chunks=0-1", "bytes=0-1,", ""]) {
      expect(parseByteRange(bad, size)).toEqual({ kind: "unsatisfiable" });
    }
    expect(parseByteRange("bytes=0-99", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

// ───────────────── DB integration (CI) ─────────────────

describe.skipIf(!databaseUrl)("broadcast audio cache (H-112, D14)", () => {
  const db = makeClient();
  let cacheDir: string;

  /** Fixture body: valid mp3-shaped bytes (ID3), deterministic. */
  const BODY_A = new Uint8Array(2048).map((_, i) => (i * 7 + 3) & 0xff);
  BODY_A[0] = 0x49; BODY_A[1] = 0x44; BODY_A[2] = 0x33;
  const HASH_A = createHash("sha256").update(BODY_A).digest("hex");

  beforeEach(async () => {
    await cleanTables(db);
    cacheDir = mkdtempSync(join(tmpdir(), "huk-audio-cache-test-"));
    process.env.AUDIO_CACHE_DIR = cacheDir;
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
    delete process.env.AUDIO_CACHE_DIR;
  });

  const t0 = Date.now();

  async function mkTrack(
    title: string,
    opts: { provider?: string; url?: string; hash?: string | null; bytes?: number | null; status?: string; available?: boolean } = {},
  ): Promise<string> {
    const track = await db.track.create({
      data: {
        title,
        status: (opts.status ?? "APPROVED") as never,
        available: opts.available ?? true,
        durationSec: 120,
      },
    });
    await db.trackSource.create({
      data: {
        trackId: track.id,
        provider: (opts.provider ?? "DIRECT_URL") as never,
        url: opts.url ?? `https://author.example/${encodeURIComponent(title)}.mp3`,
        contentHash: opts.hash === undefined ? HASH_A : opts.hash,
        byteLength: opts.bytes === undefined ? BigInt(BODY_A.byteLength) : opts.bytes === null ? null : BigInt(opts.bytes),
      },
    });
    return track.id;
  }

  async function mkSlot(trackId: string, seq: bigint, startMs: number, endMs: number): Promise<void> {
    await db.broadcastSlot.create({ data: { seq, trackId, startsAt: new Date(startMs), endsAt: new Date(endMs) } });
  }

  function fakeLoader(body: Uint8Array | "transport-fail", calls: Array<{ url: string; method: string }>): SafeLoader {
    return async (req) => {
      calls.push({ url: String(req.url), method: req.method });
      if (body === "transport-fail") {
        const e = new Error("connect ECONNREFUSED 203.0.113.9:443") as Error & { code: string };
        e.code = "ECONNREFUSED";
        throw e;
      }
      return { status: 200, headers: {}, body, bytes: body.byteLength, url: req.url.toString() };
    };
  }

  function seamOver(over: Partial<AudioCacheSeam> & { loader: SafeLoader }): AudioCacheSeam {
    return {
      client: db as unknown as PrismaClient,
      env: { AUDIO_CACHE_DIR: cacheDir, AUDIO_CACHE_MAX_BYTES: 64 * 1024 * 1024, SOURCE_MAX_FAILS: 5 },
      dir: cacheDir,
      ...over,
    };
  }

  function audioReq(trackId: string, opts: { ip?: string; headers?: Record<string, string> } = {}): Request {
    return new Request(`http://localhost:3000/api/audio/${trackId}`, {
      headers: { "cf-connecting-ip": opts.ip ?? "203.0.113.77", ...(opts.headers ?? {}) },
    });
  }
  const ctxFor = (trackId: string) => ({ params: Promise.resolve({ trackId }) });
  const fileOf = (trackId: string) => join(cacheDir, cacheFileName(trackId, HASH_A));

  it("50 listeners across one airing hit the author host exactly once (D14)", async () => {
    const id = await mkTrack("once");
    await mkSlot(id, 1n, t0 - 10_000, t0 + 300_000);
    const calls: Array<{ url: string; method: string }> = [];
    const summary = await runAudioCachePass(seamOver({ loader: fakeLoader(BODY_A, calls) }), makeAudioCacheState());
    expect(summary.fetched).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("author.example/once.mp3");

    for (let i = 0; i < 50; i++) {
      const res = await audioGET(audioReq(id, { ip: "198.51.100.5" }), ctxFor(id));
      expect(res.status).toBe(200);
      const got = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(got).equals(Buffer.from(BODY_A))).toBe(true);
    }
    expect(calls).toHaveLength(1); // the author host saw ONE GET
  });

  it("/now maps DIRECT_URL to /api/audio/<id>; AUDIUS and SEED keep their URLs; still ≤ 2 queries", async () => {
    const direct = await mkTrack("direct");
    const seed = await mkTrack("seeded", { provider: "SEED", url: "https://example.com/seed.mp3", hash: null });
    const audius = await mkTrack("audius", { provider: "AUDIUS", url: "https://audius.example/a.mp3", hash: null });
    await mkSlot(direct, 1n, t0 - 10_000, t0 + 10_000);
    await mkSlot(seed, 2n, t0 + 20_000, t0 + 40_000);
    await mkSlot(audius, 3n, t0 + 40_000, t0 + 60_000);

    let queries = 0;
    const countingClient = {
      $queryRaw: (...args: unknown[]) => {
        queries++;
        return (db.$queryRaw as (...a: unknown[]) => unknown)(...args);
      },
    };
    const result = await radioNow(t0, countingClient as never);
    expect(queries).toBeLessThanOrEqual(2);
    expect(result.current?.track.audioUrl).toBe(`/api/audio/${direct}`);
    expect(result.next.map((s) => s.track.audioUrl)).toEqual([
      "https://example.com/seed.mp3",
      "https://audius.example/a.mp3",
    ]);
  });

  it("hash mismatch: bytes are not kept, the track is suspended and retired", async () => {
    const id = await mkTrack("liar");
    await mkSlot(id, 1n, t0 - 10_000, t0 + 300_000);
    await mkSlot(id, 2n, t0 + 600_000, t0 + 700_000);
    const otherBody = new Uint8Array(512).fill(9);
    const calls: Array<{ url: string; method: string }> = [];
    const summary = await runAudioCachePass(seamOver({ loader: fakeLoader(otherBody, calls) }), makeAudioCacheState());
    expect(summary.mismatched).toBe(1);

    expect((await db.track.findUnique({ where: { id } }))!.status).toBe("SUSPENDED");
    const runs = await db.moderationRun.findMany({ where: { trackId: id } });
    expect(runs.some((r) => r.verdict === "REVIEW" && r.stage === "TECHNICAL")).toBe(true);
    expect(await db.broadcastSlot.count({ where: { trackId: id } })).toBe(0); // retired from air
    expect(existsSync(fileOf(id))).toBe(false); // the bytes were never kept
    const audits = await db.auditLog.findMany({ where: { targetId: id } });
    expect(audits.some((a) => a.action === "source.mismatch")).toBe(true);
  });

  it("offline host: backoff series fails, one failure counted, slots replaced, cool-down holds, host returns → cached", async () => {
    const id = await mkTrack("flaky");
    // Live slot started a minute ago: the first attempt is due immediately.
    await mkSlot(id, 1n, t0 - 60_000, t0 + 300_000);
    await mkSlot(id, 2n, t0 + 600_000, t0 + 700_000);
    let fakeNow = t0;
    const calls: Array<{ url: string; method: string }> = [];
    const state = makeAudioCacheState();
    const failing = fakeLoader("transport-fail", calls);
    const seam = seamOver({ loader: failing, now: () => fakeNow });

    const s1 = await runAudioCachePass(seam, state); // attempt 1 (due: start-60s+15s < t0)
    expect(s1.failedSeries).toBe(0);
    fakeNow += 60_000;
    await runAudioCachePass(seam, state); // attempt 2
    fakeNow += 120_000;
    await runAudioCachePass(seam, state); // attempt 3
    fakeNow += 180_000;
    const s4 = await runAudioCachePass(seam, state); // attempt 4 → series failed
    expect(s4.failedSeries).toBe(1);
    expect(calls).toHaveLength(4); // 15 s, 1 min, 3 min, 6 min — one fetch per attempt

    const source = await db.trackSource.findUnique({ where: { trackId: id } });
    expect(source!.failCount).toBe(1); // one whole series = ONE failure
    expect(source!.cacheRetryAfter!.getTime()).toBe(fakeNow + CACHE_COOLDOWN_MS);
    expect((await db.track.findUnique({ where: { id } }))!.available).toBe(true); // one outage ≠ unavailable
    expect(await db.broadcastSlot.count({ where: { trackId: id, startsAt: { gt: new Date(fakeNow) } } })).toBe(0); // future slot replaced at once

    // During the cool-down the host is not touched again.
    fakeNow += 60_000;
    const s5 = await runAudioCachePass(seam, state);
    expect(s5.fetched).toBe(0);
    expect(calls).toHaveLength(4);

    // The host is back after the cool-down → cached and aired again.
    const working = fakeLoader(BODY_A, calls);
    fakeNow += CACHE_COOLDOWN_MS + 120_000;
    await mkSlot(id, 3n, fakeNow - 30_000, fakeNow + 300_000);
    const s6 = await runAudioCachePass(seamOver({ loader: working, now: () => fakeNow }), state);
    expect(s6.fetched).toBe(1);
    expect(existsSync(fileOf(id))).toBe(true);
  });

  it("a slot on air without cached audio is skipped (S9, fail closed) — no fallback to the author URL", async () => {
    const id = await mkTrack("uncached");
    await mkSlot(id, 1n, t0 - 5_000, t0 + 300_000); // live, nothing cached yet
    const calls: Array<{ url: string; method: string }> = [];
    // The series is still pending (first attempt due in 10 s), yet the slot
    // must be skipped the moment it airs uncached — never stream the author.
    const seam = seamOver({ loader: fakeLoader(BODY_A, calls), now: () => t0 });
    const summary = await runAudioCachePass(seam, makeAudioCacheState());
    expect(summary.skippedSlots).toBe(1);
    const slot = await db.broadcastSlot.findFirst({ where: { trackId: id } });
    expect(slot!.endsAt.getTime()).toBeLessThanOrEqual(t0); // ended now — the hole is the scheduler's to fill
    const res = await audioGET(audioReq(id), ctxFor(id));
    expect(res.status).toBe(404); // no fallback
    expect(calls).toHaveLength(0); // the author host was never contacted for the live slot
  });

  it("eviction: grace after slot end, leaving the window, availability, takedown purge, boot sweep", async () => {
    const a = await mkTrack("evict-a"); // live
    const b = await mkTrack("evict-b"); // upcoming
    await mkSlot(a, 1n, t0 - 10_000, t0 + 300_000);
    await mkSlot(b, 2n, t0 + 60_000, t0 + 200_000);
    const calls: Array<{ url: string; method: string }> = [];
    const seam = seamOver({ loader: fakeLoader(BODY_A, calls), now: () => t0 });
    const state = makeAudioCacheState();
    await runAudioCachePass(seam, state);
    await runAudioCachePass({ ...seam, now: () => t0 + 65_000 }, state); // b is in the window now
    expect(existsSync(fileOf(a))).toBe(true);
    expect(existsSync(fileOf(b))).toBe(true);
    writeFileSync(join(cacheDir, "cdeadbeefdeadbeefdeadbeeff.000000000000.cache"), "stray"); // not in the window

    // Boot sweep: the stray goes, in-window files stay.
    expect(await sweepCacheAtStartAsync({ client: db as unknown as PrismaClient, dir: cacheDir, now: () => t0 + 65_000 })).toBe(1);
    expect(existsSync(fileOf(a))).toBe(true);

    // Grace: after the slot ends + 60 s the copy is evicted.
    await runAudioCachePass({ ...seam, now: () => t0 + 300_000 + CACHE_GRACE_MS + 1000 }, state);
    expect(existsSync(fileOf(a))).toBe(false);
    expect(existsSync(fileOf(b))).toBe(true);

    // Availability: an unavailable track's copy is dropped by the next pass.
    await db.track.update({ where: { id: b }, data: { available: false } });
    await runAudioCachePass({ ...seam, now: () => t0 + 65_000 }, state);
    expect(existsSync(fileOf(b))).toBe(false);

    // Takedown: retireTrackFromAir purges the copy in the same code path.
    const c = await mkTrack("evict-c");
    await mkSlot(c, 3n, t0 + 300_000, t0 + 400_000);
    await runAudioCachePass({ ...seam, now: () => t0 + 300_001 }, state);
    expect(existsSync(fileOf(c))).toBe(true);
    await retireTrackFromAir(c, new Date(), db);
    expect(existsSync(fileOf(c))).toBe(false);
    expect(purgeTrackFromCache("cnottaken", cacheDir)).toBe(0); // unknown id is a no-op
  });

  it("cache full: no fetch beyond the cap, the attempt is not consumed, in-window entries are never evicted", async () => {
    const a = await mkTrack("fits");
    const big = await mkTrack("toobig", { bytes: 32 * 1024 * 1024 });
    await mkSlot(a, 1n, t0 - 10_000, t0 + 300_000);
    await mkSlot(big, 2n, t0 + 10_000, t0 + 300_000);
    const calls: Array<{ url: string; method: string }> = [];
    const state = makeAudioCacheState();
    const seam = seamOver({
      loader: fakeLoader(BODY_A, calls),
      env: { AUDIO_CACHE_DIR: cacheDir, AUDIO_CACHE_MAX_BYTES: 16 * 1024 * 1024, SOURCE_MAX_FAILS: 5 },
    });

    await runAudioCachePass(seam, state);
    expect(existsSync(fileOf(a))).toBe(true); // 2 KB entry fits under 16 MB

    const before = calls.length;
    const summary = await runAudioCachePass(seam, state);
    expect(summary.cacheFull).toBe(1); // 32 MB refused against the cap, pre-fetch
    expect(calls.length).toBe(before); // never fetched
    expect(existsSync(fileOf(a))).toBe(true); // in-window entry kept
    const source = await db.trackSource.findUnique({ where: { trackId: big } });
    expect(source!.cacheRetryAfter).toBeNull(); // our-side condition — no cool-down, no failure
  });

  it("route: identical plain 404 for unknown, malformed, out-of-window, non-approved, unavailable", async () => {
    const id = await mkTrack("routed");
    const pending = await mkTrack("pending-r", { status: "PENDING" });
    const gone = await mkTrack("gone-r", { available: false });
    await mkSlot(id, 1n, t0 - 10_000, t0 + 300_000);
    await mkSlot(pending, 2n, t0 - 10_000, t0 + 300_000);
    await mkSlot(gone, 3n, t0 - 10_000, t0 + 300_000);
    const calls: Array<{ url: string; method: string }> = [];
    await runAudioCachePass(seamOver({ loader: fakeLoader(BODY_A, calls) }), makeAudioCacheState());

    const noSlot = await mkTrack("routed-noslot");
    const cases: Array<[string, string]> = [
      ["unknown", "c0000000000000000000000000"],
      ["malformed traversal", "../../etc/passwd"],
      ["malformed short", "abc"],
      ["malformed charset", "C1234567890123456789012345"],
      ["out of window", noSlot],
      ["not approved", pending],
      ["unavailable", gone],
    ];
    for (const [label, trackId] of cases) {
      const res = await audioGET(audioReq(trackId), ctxFor(trackId));
      expect(res.status, label).toBe(404);
      expect(await res.text(), label).toBe("Not Found");
      // HEAD answers with the same status — no oracle in the method either.
      const head = await audioHEAD(audioReq(trackId), ctxFor(trackId));
      expect(head.status, `head ${label}`).toBe(404);
    }
  });

  it("route: 200, HEAD, 206 (a-b, a-, -n) byte-for-byte, 416 (invalid, multi-range), headers", async () => {
    const id = await mkTrack("ranges");
    await mkSlot(id, 1n, t0 - 10_000, t0 + 300_000);
    const calls: Array<{ url: string; method: string }> = [];
    await runAudioCachePass(seamOver({ loader: fakeLoader(BODY_A, calls) }), makeAudioCacheState());
    const size = BODY_A.byteLength;

    const full = await audioGET(audioReq(id), ctxFor(id));
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("etag")).toBe(`"${HASH_A}"`);
    expect(full.headers.get("content-type")).toBe("audio/mpeg"); // sniffed from the bytes
    expect(full.headers.get("cache-control")).toBe("private, max-age=300, no-transform");
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Number(full.headers.get("content-length"))).toBe(size);
    expect(Buffer.from(new Uint8Array(await full.arrayBuffer())).equals(Buffer.from(BODY_A))).toBe(true);

    const head = await audioHEAD(audioReq(id), ctxFor(id));
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(size);
    expect(await head.text()).toBe("");

    const mid = await audioGET(audioReq(id, { headers: { range: "bytes=100-199" } }), ctxFor(id));
    expect(mid.status).toBe(206);
    expect(mid.headers.get("content-range")).toBe(`bytes 100-199/${size}`);
    expect(mid.headers.get("content-length")).toBe("100");
    expect(Buffer.from(new Uint8Array(await mid.arrayBuffer())).equals(BODY_A.subarray(100, 200))).toBe(true);

    const tail = await audioGET(audioReq(id, { headers: { range: `bytes=${size - 10}-` } }), ctxFor(id));
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    expect(Buffer.from(new Uint8Array(await tail.arrayBuffer())).equals(BODY_A.subarray(size - 10))).toBe(true);

    const suffix = await audioGET(audioReq(id, { headers: { range: "bytes=-7" } }), ctxFor(id));
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(`bytes ${size - 7}-${size - 1}/${size}`);
    expect(Buffer.from(new Uint8Array(await suffix.arrayBuffer())).equals(BODY_A.subarray(size - 7))).toBe(true);

    for (const bad of ["bytes=500-400", `bytes=${size}-`, "bytes=0-1,3-4", "bytes=abc"]) {
      const res = await audioGET(audioReq(id, { headers: { range: bad } }), ctxFor(id));
      expect(res.status, bad).toBe(416);
      expect(res.headers.get("content-range")).toBe(`bytes */${size}`);
    }
  });

  it("route: a symlinked cache entry is never served; malformed ids never touch the FS", async () => {
    const id = await mkTrack("links");
    await mkSlot(id, 1n, t0 - 10_000, t0 + 300_000);
    const calls: Array<{ url: string; method: string }> = [];
    await runAudioCachePass(seamOver({ loader: fakeLoader(BODY_A, calls) }), makeAudioCacheState());
    const path = fileOf(id);
    const backup = readFileSync(path);
    unlinkSync(path);
    symlinkSync("/etc/hostname", path);
    const res = await audioGET(audioReq(id), ctxFor(id));
    expect(res.status).toBe(404); // lstat sees the symlink — refused
    unlinkSync(path);
    writeFileSync(path, backup); // restore for cleanup symmetry

    const traversal = await audioGET(audioReq("%2e%2e%2f%2e%2e%2fetc%2fpasswd"), ctxFor("../../etc/passwd"));
    expect(traversal.status).toBe(404);
  });

  it("route: per-IP rate limit answers 429 with Retry-After", async () => {
    const ip = "192.0.2.200";
    let last = 200;
    for (let i = 0; i < 121; i++) {
      const res = await audioGET(audioReq("c0000000000000000000000000", { ip }), ctxFor("c0000000000000000000000000"));
      last = res.status;
      if (res.status === 429) {
        expect(res.headers.get("retry-after")).toBeTruthy();
        break;
      }
    }
    expect(last).toBe(429);
  }, 30_000);
});
