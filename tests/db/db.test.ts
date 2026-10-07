import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { cleanTables, databaseUrl, makeClient, skipMessage } from "./helpers";
import { seed } from "../../prisma/seed";
import { purgeExpiredBuckets, rateLimit } from "@/server/ratelimit";
import { endCurrentSlotEarly, startScheduler } from "@/server/broadcast/scheduler";
import { radioNow } from "@/app/api/radio/now/route";
import { seedTracks, type SeedFileInput } from "../../prisma/seed-tracks";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import { makeAuthOptions } from "@/server/auth/options";
import { withSignInRateLimit } from "@/server/auth/signin-limit";
import { loadEnv } from "@/server/env";
import { SESSION_COOKIE, requireRole, requireSession, requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

interface MatrixFile {
  actors: string[];
  routes: Record<string, {
    method: string;
    skipCall?: boolean;
    expected: Record<string, number>;
  }>;
}

/** Polls `cond` until true or the timeout elapses (CI runners are slow). */
async function pollUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += stepMs) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return await cond();
}

// DB integration tests (H-101), single file so the suites never run in
// parallel workers: every suite TRUNCATEs the shared tables in beforeEach and
// would race another file's fixtures. One test per DB constraint introduced
// by the H-101 migration (prisma/migrations/*_constraints); every test proves
// an invalid row is rejected by Postgres, and the valid baselines prove the
// constraints are not over-tight. Case-insensitive uniqueness covered for
// User.email and ArtistProfile.handle; seed idempotency covered at the end.

if (!databaseUrl) console.log(skipMessage());

describe.skipIf(!databaseUrl)("DB constraints (H-101)", () => {
  const db = makeClient();

  beforeEach(async () => {
    await cleanTables(db);
  });

  it("connects to the database at DATABASE_URL (fails loudly when unreachable)", async () => {
    await expect(db.$queryRaw`SELECT 1`).resolves.toBeTruthy();
  });

  it("rejects a second User whose email differs only by case (lower(email) unique)", async () => {
    await db.user.create({ data: { email: "A@x.com", reputation: 1 } });
    await expect(db.user.create({ data: { email: "a@x.com", reputation: 1 } })).rejects.toThrow();
    await expect(db.user.findMany()).resolves.toHaveLength(1);
  });

  it("rejects a second ArtistProfile whose handle differs only by case (lower(handle) unique)", async () => {
    const first = await db.user.create({ data: { email: "one@x.com", reputation: 1 } });
    const second = await db.user.create({ data: { email: "two@x.com", reputation: 1 } });
    await db.artistProfile.create({ data: { userId: first.id, handle: "Alpha", displayName: "A" } });
    await expect(
      db.artistProfile.create({ data: { userId: second.id, handle: "alpha", displayName: "B" } }),
    ).rejects.toThrow();
  });

  it("rejects a Track with negative durationSec", async () => {
    await expect(
      db.track.create({ data: { title: "ok", durationSec: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Track with aiConfidence outside [0, 1] (null is allowed)", async () => {
    await expect(
      db.track.create({ data: { title: "ok", aiConfidence: 1.5 } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(db.track.create({ data: { title: "null is fine", aiConfidence: null } })).resolves.toBeTruthy();
  });

  it("rejects a ModerationRun with confidence outside [0, 1]", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.moderationRun.create({
        data: { trackId: track.id, stage: "TECHNICAL", verdict: "APPROVE", confidence: -0.1 },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a ListenEvent with negative msListened", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.listenEvent.create({ data: { trackId: track.id, mode: "RADIO", msListened: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a PlaylistItem with negative position", async () => {
    const owner = await db.user.create({ data: { email: "p@x.com", reputation: 1 } });
    const track = await db.track.create({ data: { title: "ok" } });
    const playlist = await db.playlist.create({ data: { ownerId: owner.id, name: "mix" } });
    await expect(
      db.playlistItem.create({ data: { playlistId: playlist.id, trackId: track.id, position: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a ChartEntry with rank below 1", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    const snapshot = await db.chartSnapshot.create({
      data: { weekStart: new Date("2026-10-05T00:00:00Z"), categoryKey: "all" },
    });
    await expect(
      db.chartEntry.create({ data: { snapshotId: snapshot.id, rank: 0, trackId: track.id, score: 1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a User with negative reputation", async () => {
    await expect(
      db.user.create({ data: { email: "neg@x.com", reputation: -0.5 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a TrackSource with negative failCount", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.trackSource.create({
        data: { trackId: track.id, provider: "DIRECT_URL", url: "https://example.com/a.mp3", failCount: -1 },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Report with negative urgency", async () => {
    await expect(
      db.report.create({ data: { targetType: "TRACK", targetId: "cuid1", reason: "r", urgency: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a BroadcastSlot whose endsAt is not after startsAt", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    const start = new Date("2026-10-07T10:00:00Z");
    await expect(
      db.broadcastSlot.create({
        data: { seq: 1n, trackId: track.id, startsAt: start, endsAt: new Date(start.getTime() - 1000) },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Track with an empty or over-200-char title", async () => {
    await expect(db.track.create({ data: { title: "" } })).rejects.toThrow(/violates check constraint/);
    await expect(
      db.track.create({ data: { title: "x".repeat(201) } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(db.track.create({ data: { title: "x".repeat(200) } })).resolves.toBeTruthy();
  });

  it("rejects a Comment with a body over 2000 chars", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.comment.create({ data: { trackId: track.id, body: "x".repeat(2001) } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(
      db.comment.create({ data: { trackId: track.id, body: "x".repeat(2000) } }),
    ).resolves.toBeTruthy();
  });

  it("rejects a Playlist with an empty or over-100-char name", async () => {
    const owner = await db.user.create({ data: { email: "n@x.com", reputation: 1 } });
    await expect(db.playlist.create({ data: { ownerId: owner.id, name: "" } })).rejects.toThrow(
      /violates check constraint/,
    );
    await expect(
      db.playlist.create({ data: { ownerId: owner.id, name: "x".repeat(101) } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("accepts a valid end-to-end graph (constraints are not over-tight)", async () => {
    const user = await db.user.create({ data: { email: "Main@X.com", reputation: 1 } });
    const artist = await db.artistProfile.create({
      data: { userId: user.id, handle: "Alpha", displayName: "Alpha" },
    });
    const track = await db.track.create({
      data: { title: "Song", artistId: artist.id, durationSec: 180, aiConfidence: 0.5 },
    });
    await db.trackSource.create({
      data: { trackId: track.id, provider: "DIRECT_URL", url: "https://example.com/a.mp3", failCount: 0 },
    });
    await db.broadcastSlot.create({
      data: {
        seq: 1n,
        trackId: track.id,
        startsAt: new Date("2026-10-07T10:00:00Z"),
        endsAt: new Date("2026-10-07T10:03:00Z"),
      },
    });
    await expect(db.track.count()).resolves.toBe(1);
  });
});

describe.skipIf(!databaseUrl)("seed (H-101)", () => {
  const db = makeClient();

  beforeEach(async () => {
    await cleanTables(db);
  });

  it("is idempotent: two runs leave identical row counts", async () => {
    await seed(db);
    const afterFirst = {
      stationStates: await db.stationState.count(),
      terms: await db.taxonomyTerm.count(),
    };

    await seed(db);
    const afterSecond = {
      stationStates: await db.stationState.count(),
      terms: await db.taxonomyTerm.count(),
    };

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.stationStates).toBe(1);
    expect(afterSecond.terms).toBe(9); // 3 per kind: LANGUAGE, STYLE, DIRECTION
  });

  it("marks the taxonomy as a placeholder until H-402", async () => {
    await seed(db);
    const terms = await db.taxonomyTerm.findMany();
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(term.label).toContain("placeholder until H-402");
    }
  });

  it("creates no users and no tracks", async () => {
    await seed(db);
    await expect(db.user.count()).resolves.toBe(0);
    await expect(db.track.count()).resolves.toBe(0);
  });
});

describe.skipIf(!databaseUrl)("rate limiter (H-103)", () => {
  const db = makeClient();

  beforeEach(async () => {
    // rateLimit() goes through the src/server/db.ts singleton, whose lazy
    // loadEnv() needs a valid environment; the CI app job provides only
    // DATABASE_URL, so supply the rest here (tests are not runtime code).
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    await cleanTables(db);
  });

  it("admits exactly `limit` requests under 50 concurrent calls", async () => {
    const limit = 5;
    const verdicts = await Promise.all(
      Array.from({ length: 50 }, () => rateLimit({ key: "test:burst", limit, windowSec: 60 })),
    );
    expect(verdicts.filter((v) => v.ok)).toHaveLength(limit);
    for (const v of verdicts) expect(v.retryAfterSec).toBeGreaterThan(0);
  });

  it("rejects within the window once the limit is reached", async () => {
    const first = await rateLimit({ key: "test:cap", limit: 2, windowSec: 60 });
    const second = await rateLimit({ key: "test:cap", limit: 2, windowSec: 60 });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const third = await rateLimit({ key: "test:cap", limit: 2, windowSec: 60 });
    expect(third.ok).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("admits again after the window rolls over", async () => {
    const first = await rateLimit({ key: "test:roll", limit: 1, windowSec: 1 });
    expect(first.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = await rateLimit({ key: "test:roll", limit: 1, windowSec: 1 });
    expect(second.ok).toBe(true);
  });

  it("purgeExpiredBuckets removes only buckets whose window fully passed", async () => {
    await rateLimit({ key: "test:purge", limit: 10, windowSec: 60 });
    // The active window is still open one minute back? No — the bucket's
    // windowStart is within the current 60 s window, so a cutoff one minute
    // in the past keeps it.
    expect(await purgeExpiredBuckets(new Date(Date.now() - 61_000))).toBe(0);
    // A cutoff beyond the active window removes it.
    expect(await purgeExpiredBuckets(new Date(Date.now() + 60_000))).toBe(1);
  });
});

describe.skipIf(!databaseUrl)("broadcast scheduler + /api/radio/now (H-104)", () => {
  const db = makeClient();

  beforeEach(async () => {
    // The scheduler tests manage their own clients and the advisory lock;
    // AUTH_SECRET is needed because the scheduler uses the db.ts singleton.
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    await cleanTables(db);
  });

  afterEach(async () => {
    await cleanTables(db);
  });

  async function seedLibrary(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const track = await db.track.create({
        data: { title: `track ${i}`, status: "APPROVED", available: true, durationSec: 20 + i },
      });
      await db.trackSource.create({
        data: { trackId: track.id, provider: "SEED", url: `https://example.com/${i}.mp3` },
      });
      ids.push(track.id);
    }
    return ids;
  }

  it("single writer: two schedulers on one Postgres — exactly one leads", async () => {
    await seedLibrary(10);
    const a = startScheduler({ tickMs: 100 });
    const b = startScheduler({ tickMs: 100 });
    try {
      // Wait (generously) until one of them leads and the timeline is filled.
      await pollUntil(() => a.isLeader() || b.isLeader(), 10_000);

      expect(a.isLeader() && b.isLeader()).toBe(false); // never both
      expect(a.isLeader() || b.isLeader()).toBe(true); // always one
      await pollUntil(async () => (await db.broadcastSlot.count()) > 0, 10_000);
      const slots = await db.broadcastSlot.count();
      expect(slots).toBeGreaterThan(0);
    } finally {
      await a.stop().catch(() => {});
      await b.stop().catch(() => {});
    }
  }, 30_000);

  it("failover: when the leader stops, the follower takes over and seq continues without duplicates", async () => {
    await seedLibrary(10);
    const a = startScheduler({ tickMs: 100 });
    await pollUntil(() => a.isLeader(), 10_000);
    expect(a.isLeader()).toBe(true);

    const follower = startScheduler({ tickMs: 100 });
    await new Promise((r) => setTimeout(r, 300));
    expect(follower.isLeader()).toBe(false);

    const seqBefore = await db.stationState.findUnique({ where: { id: "main" } });
    await a.stop();
    // Follower must take over once the lock frees (poll, CI-tolerant).
    await pollUntil(() => follower.isLeader(), 15_000);
    expect(follower.isLeader()).toBe(true);

    const newSlots = await db.broadcastSlot.count();
    expect(newSlots).toBeGreaterThan(0);
    const seqAfter = await db.stationState.findUnique({ where: { id: "main" } });
    expect(Number(seqAfter!.lastSeq)).toBeGreaterThanOrEqual(Number(seqBefore!.lastSeq));

    // No duplicate seq (also enforced by the unique constraint).
    const dupes = await db.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM (
        SELECT "seq" FROM "BroadcastSlot" GROUP BY "seq" HAVING COUNT(*) > 1
      ) d`;
    expect(Number(dupes[0].n)).toBe(0);

    await follower.stop().catch(() => {});
    await a.stop().catch(() => {});
  }, 30_000);

  it("endCurrentSlotEarly shortens the live slot; the leader refills within a tick", async () => {
    await seedLibrary(10);
    const scheduler = startScheduler({ tickMs: 100 });
    await pollUntil(async () => (await db.broadcastSlot.count()) > 0, 10_000);

    const current = await db.broadcastSlot.findFirst({
      where: { startsAt: { lte: new Date() }, endsAt: { gt: new Date() } },
      orderBy: { seq: "asc" },
    });
    expect(current).not.toBeNull();

    const shortened = await endCurrentSlotEarly(current!.trackId, new Date(Date.now() + 500));
    expect(shortened).not.toBeNull();
    expect(shortened!.endsAt.getTime()).toBeLessThan(current!.endsAt.getTime());

    // The leader fills the gap on its next tick (poll, CI-tolerant).
    const refilled = await pollUntil(async () => {
      const covering = await db.broadcastSlot.findFirst({
        where: { startsAt: { lte: new Date(Date.now() + 500) }, endsAt: { gt: new Date(Date.now() + 500) } },
        orderBy: { startsAt: "asc" },
      });
      return covering !== null && covering.trackId !== current!.trackId;
    }, 15_000);
    try {
      expect(refilled).toBe(true);
    } finally {
      await scheduler.stop();
    }
  }, 30_000);

  it("/api/radio/now is a pure read: at most 2 queries, no moderation fields, public URL", async () => {
    const ids = await seedLibrary(12);
    const nowMs = Date.now();
    // Slots: one covering now, a few upcoming.
    await db.broadcastSlot.createMany({
      data: [
        { seq: 1n, trackId: ids[0], startsAt: new Date(nowMs - 10_000), endsAt: new Date(nowMs + 10_000) },
        { seq: 2n, trackId: ids[1], startsAt: new Date(nowMs + 10_000), endsAt: new Date(nowMs + 30_000) },
        { seq: 3n, trackId: ids[2], startsAt: new Date(nowMs + 30_000), endsAt: new Date(nowMs + 50_000) },
      ],
    });
    // Moderation payload that must NOT leak.
    await db.track.update({
      where: { id: ids[0] },
      data: { aiConfidence: 0.9, aiSummary: "internal", moderatedBy: "ai", status: "APPROVED" },
    });

    let queries = 0;
    const countingClient = {
      $queryRaw: (...args: unknown[]) => {
        queries++;
        return (db.$queryRaw as (...a: unknown[]) => unknown)(...args);
      },
    };
    const result = await radioNow(nowMs, countingClient as never);
    expect(queries).toBeLessThanOrEqual(2);

    expect(result.current).not.toBeNull();
    expect(result.current!.track.id).toBe(ids[0]);
    expect(result.current!.track.audioUrl).toBe("https://example.com/0.mp3");
    expect(result.current!.offsetMs).toBe(10_000);
    expect(result.next).toHaveLength(2);
    expect(result.next[0].track.id).toBe(ids[1]);

    const bodyText = JSON.stringify(result);
    expect(bodyText).not.toContain("aiConfidence");
    expect(bodyText).not.toContain("aiSummary");
    expect(bodyText).not.toContain("internal");
    expect(bodyText).not.toContain("moderatedBy");
  });

  it("empty timeline → current: null, next: []", async () => {
    const result = await radioNow(Date.now(), db);
    expect(result.current).toBeNull();
    expect(result.next).toEqual([]);
  });

  it("/now omits slots of non-approved or unavailable tracks (H-110 F3, S2), at most 2 queries", async () => {
    const nowMs = Date.now();
    const mk = async (title: string, status: string, available: boolean) => {
      const track = await db.track.create({ data: { title, status: status as never, available, durationSec: 60 } });
      await db.trackSource.create({
        data: { trackId: track.id, provider: "SEED", url: `https://example.com/${title}.mp3` },
      });
      return track.id;
    };
    const good = await mk("good", "APPROVED", true);
    const pending = await mk("pending-track", "PENDING", true);
    const gone = await mk("gone", "APPROVED", false);

    await db.broadcastSlot.createMany({
      data: [
        { seq: 1n, trackId: pending, startsAt: new Date(nowMs - 10_000), endsAt: new Date(nowMs + 10_000) },
        { seq: 2n, trackId: gone, startsAt: new Date(nowMs + 10_000), endsAt: new Date(nowMs + 30_000) },
        { seq: 3n, trackId: good, startsAt: new Date(nowMs + 30_000), endsAt: new Date(nowMs + 50_000) },
      ],
    });

    let queries = 0;
    const countingClient = {
      $queryRaw: (...args: unknown[]) => {
        queries++;
        return (db.$queryRaw as (...a: unknown[]) => unknown)(...args);
      },
    };
    const result = await radioNow(nowMs, countingClient as never);

    // Only the APPROVED + available track is served (current and next).
    const servedIds = [
      ...(result.current ? [result.current.track.id] : []),
      ...result.next.map((s) => s.track.id),
    ];
    expect(servedIds).toEqual([good]);
    expect(servedIds).not.toContain(pending);
    expect(servedIds).not.toContain(gone);

    // The read stays a pure read: at most 2 queries (F3 done criteria).
    expect(queries).toBeLessThanOrEqual(2);
  });

  it("never schedules non-APPROVED or unavailable tracks (S2)", async () => {
    await seedLibrary(5);
    await db.track.create({ data: { title: "draft", status: "DRAFT", available: true, durationSec: 60 } });
    await db.track.create({ data: { title: "gone", status: "APPROVED", available: false, durationSec: 60 } });
    const scheduler = startScheduler({ tickMs: 100 });
    await pollUntil(async () => (await db.broadcastSlot.count()) > 0, 10_000);
    const scheduled = await db.broadcastSlot.findMany({ select: { trackId: true } });
    expect(scheduled.length).toBeGreaterThan(0);
    const scheduledIds = new Set(scheduled.map((s) => s.trackId));
    const forbidden = await db.track.findFirst({
      where: { OR: [{ status: "DRAFT" }, { available: false }], id: { in: [...scheduledIds] } },
    });
    expect(forbidden).toBeNull();
    await scheduler.stop();
  }, 20_000);

  it("the worker exits 0 on SIGTERM and releases the advisory lock", async () => {
    await seedLibrary(5);
    const envForWorker = {
      ...process.env,
      DATABASE_URL: databaseUrl!,
      AUTH_SECRET: "test-only fixture value, not a credential",
    };
    const child = spawn("bun", ["src/worker/index.ts"], { env: envForWorker, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));

    // Wait for boot.
    for (let i = 0; i < 200 && !output.includes("broadcast scheduler started"); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(output).toContain("broadcast scheduler started");

    // The worker holds the lock once its first tick acquires it (poll: CI is
    // slower than a local disk, so a single snapshot would race the boot).
    let held = false;
    for (let i = 0; i < 200 && !held; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rows = await db.$queryRaw<{ held: boolean }[]>`
        SELECT COUNT(*) > 0 AS held FROM pg_locks WHERE locktype = 'advisory' AND granted = true`;
      held = rows[0].held;
    }
    expect(held).toBe(true);

    child.kill("SIGTERM");
    const exitCode: number = await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? -1)));
    expect(exitCode).toBe(0);
    expect(output).toContain("exiting cleanly");

    // The lock is released (poll briefly: the unlock happens just before exit).
    let heldAfter = true;
    for (let i = 0; i < 200 && heldAfter; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rows = await db.$queryRaw<{ held: boolean }[]>`
        SELECT COUNT(*) > 0 AS held FROM pg_locks WHERE locktype = 'advisory' AND granted = true`;
      heldAfter = rows[0].held;
    }
    expect(heldAfter).toBe(false);
  }, 30_000);
});

describe.skipIf(!databaseUrl)("seed:tracks (H-106)", () => {
  const db = makeClient();

  beforeEach(async () => {
    await cleanTables(db);
  });

  afterEach(async () => {
    await cleanTables(db);
  });

  const fixture = (name: string, content: string): SeedFileInput => ({
    fileName: name,
    bytes: new TextEncoder().encode(content),
    durationSec: 100.2,
    title: name.replace(/\.mp3$/i, ""),
  });

  it("is idempotent: two runs leave identical row counts", async () => {
    const files = [
      fixture("synthwave_neon_rain.mp3", "audio-bytes-one"),
      fixture("lofi_study_room.mp3", "audio-bytes-two"),
      fixture("dance_pulse_floor.mp3", "audio-bytes-three"),
    ];

    await seedTracks(db, files);
    const afterFirst = {
      tracks: await db.track.count(),
      sources: await db.trackSource.count(),
    };

    await seedTracks(db, files);
    const afterSecond = {
      tracks: await db.track.count(),
      sources: await db.trackSource.count(),
    };

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.tracks).toBe(3);
    expect(afterSecond.sources).toBe(3);
  });

  it("registers SEED tracks exactly as the naryad specifies", async () => {
    const bytes = new TextEncoder().encode("procedural audio bytes");
    await seedTracks(db, [fixture("lofi_study_room.mp3", "procedural audio bytes")]);

    const source = await db.trackSource.findFirstOrThrow({
      where: { externalId: "lofi_study_room.mp3" },
      include: { track: true },
    });
    expect(source.provider).toBe("SEED");
    expect(source.url).toBe("/seed/lofi_study_room.mp3");
    expect(source.contentHash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Number(source.byteLength)).toBe(bytes.byteLength);

    expect(source.track.status).toBe("APPROVED");
    expect(source.track.moderatedBy).toBe("seed");
    expect(source.track.aiGenerated).toBe(true);
    expect(source.track.aiTool).toBe("procedural (HUK seed script)");
    expect(source.track.licenseScope).toBe("RADIO_AND_PLAYLISTS");
    expect(source.track.durationSec).toBe(100.2);
  });

  it("updates contentHash when the file changes, still without duplicating rows", async () => {
    await seedTracks(db, [fixture("dance_pulse_floor.mp3", "v1 bytes")]);
    await seedTracks(db, [fixture("dance_pulse_floor.mp3", "v2 bytes — regenerated")]);
    const sources = await db.trackSource.findMany({ where: { externalId: "dance_pulse_floor.mp3" } });
    expect(sources).toHaveLength(1);
    expect(sources[0].contentHash).toBe(createHash("sha256").update("v2 bytes — regenerated").digest("hex"));
  });
});

describe.skipIf(!databaseUrl)("auth guard, matrix and magic-link flows (H-102)", () => {
  const db = makeClient();

  beforeEach(async () => {
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    process.env.NEXTAUTH_URL ??= "http://localhost:3000";
    await cleanTables(db);
  });

  afterEach(async () => {
    await cleanTables(db);
  });

  const future = (ms: number) => new Date(Date.now() + ms);

  async function createUserWithSession(role: string, opts?: { banned?: boolean; deleted?: boolean }) {
    const user = await db.user.create({
      data: {
        email: `${role.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.example`,
        role: role as never,
        bannedUntil: opts?.banned ? future(60 * 60 * 1000) : null,
        deletedAt: opts?.deleted ? new Date() : null,
      },
    });
    const session = await db.session.create({
      data: { userId: user.id, sessionToken: `tok-${user.id}`, expires: future(24 * 60 * 60 * 1000) },
    });
    return { user, session };
  }

  function requestWithCookie(token: string): Request {
    return new Request("http://localhost:3000/api/health", {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
  }

  it("guard: 401 without a session, with an expired session, and fail-closed on garbage cookies", async () => {
    await expect(requireUser(new Request("http://localhost:3000/"))).rejects.toMatchObject({ status: 401 });

    const { user } = await createUserWithSession("LISTENER");
    await db.session.update({
      where: { sessionToken: `tok-${user.id}` },
      data: { expires: new Date(Date.now() - 1000) },
    });
    await expect(requireUser(requestWithCookie(`tok-${user.id}`))).rejects.toMatchObject({ status: 401 });

    // Fail closed: malformed cookies never yield a session or a 500.
    await expect(
      requireUser(new Request("http://localhost:3000/", { headers: { cookie: "%%%broken%%%" } })),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("guard: banned and deleted users get 403; a valid listener passes", async () => {
    const banned = await createUserWithSession("LISTENER", { banned: true });
    await expect(requireUser(requestWithCookie(`tok-${banned.user.id}`))).rejects.toMatchObject({
      status: 403,
      code: "BANNED",
    });

    const deleted = await createUserWithSession("LISTENER", { deleted: true });
    await expect(requireUser(requestWithCookie(`tok-${deleted.user.id}`))).rejects.toMatchObject({
      status: 403,
      code: "ACCOUNT_DELETED",
    });

    const ok = await createUserWithSession("LISTENER");
    const { user } = await requireUser(requestWithCookie(`tok-${ok.user.id}`));
    expect(user.id).toBe(ok.user.id);

    const { session } = await requireSession(requestWithCookie(`tok-${ok.user.id}`));
    expect(session.sessionToken).toBe(`tok-${ok.user.id}`);
  });

  it("guard: requireRole enforces roles, ADMIN satisfies MODERATOR, changes apply on the next request", async () => {
    const listener = await createUserWithSession("LISTENER");
    await expect(
      requireRole(requestWithCookie(`tok-${listener.user.id}`), "MODERATOR"),
    ).rejects.toMatchObject({ status: 403 });

    // A role change takes effect on the very next request (database sessions).
    await db.user.update({ where: { id: listener.user.id }, data: { role: "MODERATOR" } });
    const { user } = await requireRole(requestWithCookie(`tok-${listener.user.id}`), "MODERATOR");
    expect(user.role).toBe("MODERATOR");

    const admin = await createUserWithSession("ADMIN");
    const adminRes = await requireRole(requestWithCookie(`tok-${admin.user.id}`), "MODERATOR");
    expect(adminRes.user.role).toBe("ADMIN");
  });

  it("sign-in limiter: 429 with Retry-After after 5 sign-ins per hour per email", async () => {
    const email = "limiter@test.example";
    const env = loadEnv();
    let last: Response | null = null;
    for (let i = 0; i < 6; i++) {
      const form = new FormData();
      form.set("email", email);
      form.set("csrfToken", "ignored-here");
      const req = new NextRequest("http://localhost:3000/api/auth/signin/email", { method: "POST", body: form });
      last = await withSignInRateLimit(req, env, () => Promise.resolve(Response.json({ ok: true })));
      if (i < 5) expect(last.status).toBe(200);
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    // A different email is unaffected (per-email buckets).
    const other = new Request("http://localhost:3000/api/auth/signin/email", {
      method: "POST",
      body: (() => {
        const f = new FormData();
        f.set("email", "other@test.example");
        return f;
      })(),
    });
    const otherRes = await withSignInRateLimit(other, env, () => Promise.resolve(Response.json({ ok: true })));
    expect(otherRes.status).toBe(200);
  });

  it("magic link is built on NEXTAUTH_URL through the real Auth.js handler (H-110 F1)", async () => {
    const prevUrl = process.env.NEXTAUTH_URL;
    process.env.NEXTAUTH_URL = "https://example.test";
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      // The real NextAuth handler (pages-router entry of the very same
      // NextAuth(options) the App Router route wraps; the route glue itself
      // needs a live Next request scope, so the test drives req/res directly).
      const NextAuth = (await import("next-auth")).default;
      const handler = NextAuth(makeAuthOptions(loadEnv())) as unknown as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;

      const makeRes = () => {
        const record: {
          headers: Record<string, unknown>;
          send?: unknown;
          json?: unknown;
        } = { headers: {} };
        const res = {
          status() {
            return res;
          },
          setHeader(k: string, v: unknown) {
            record.headers[k] = v;
            return res;
          },
          getHeader(k: string) {
            return record.headers[k];
          },
          end() {},
          json(b: unknown) {
            record.json = b;
            return res;
          },
          send(b: unknown) {
            record.send = b;
            return res;
          },
        };
        return { res, record };
      };

      // Step 1: the real CSRF handshake (GET /api/auth/csrf issues the token
      // and the __Secure-next-auth.csrf-token cookie, because NEXTAUTH_URL
      // is https://example.test here).
      const step1 = makeRes();
      await handler(
        { method: "GET", url: "/api/auth/csrf", headers: {}, cookies: {}, query: { nextauth: ["csrf"] } },
        step1.res,
      );
      const csrfBody = (step1.record.json ?? step1.record.send) as { csrfToken: string };
      expect(csrfBody.csrfToken).toBeTruthy();
      const setCookies = step1.record.headers["Set-Cookie"] as string[];
      const csrfCookieLine = setCookies.find((c) => c.includes("csrf-token"));
      expect(csrfCookieLine).toBeTruthy();
      const pair = csrfCookieLine!.split(";")[0];
      const eq = pair.indexOf("=");
      const csrfCookieName = pair.slice(0, eq);
      const csrfCookieValue = decodeURIComponent(pair.slice(eq + 1));

      // Step 2: the real sign-in POST (dev path prints the magic link).
      const step2 = makeRes();
      await handler(
        {
          method: "POST",
          url: "/api/auth/signin/email",
          headers: {},
          cookies: { [csrfCookieName]: csrfCookieValue },
          query: { nextauth: ["signin", "email"] },
          body: { email: "magic-link@test.example", csrfToken: csrfBody.csrfToken },
        },
        step2.res,
      );

      // With only AUTH_URL-style env next-auth v4 would fall back to
      // http://localhost:3000; the link must instead carry the NEXTAUTH_URL host.
      const link = logs.find((l) => l.includes("callback/email"));
      expect(link, "dev path must print the magic link").toBeTruthy();
      expect(link!).toContain("https://example.test/api/auth/callback/email?");
      expect(link!).not.toContain("http://localhost:3000");
    } finally {
      logSpy.mockRestore();
      if (prevUrl === undefined) delete process.env.NEXTAUTH_URL;
      else process.env.NEXTAUTH_URL = prevUrl;
    }
  });

  it("limiter parity: normalization variants share one per-email bucket (H-110 F2)", async () => {
    const env = loadEnv();
    const variants = [
      "parity@test.example", // canonical
      "Parity@Test.Example", // case folding
      "parity@test.example,x", // domain cut at the first comma
      "  parity@test.example  ", // trim
      "\uFF30\uFF41\uFF52\uFF49\uFF54\uFF59@test.example", // NFKC fold
    ];
    let last: Response | null = null;
    for (let i = 0; i < variants.length + 1; i++) {
      const email = i < variants.length ? variants[i] : "parity@test.example";
      const form = new FormData();
      form.set("email", email);
      form.set("csrfToken", "ignored-here");
      const req = new NextRequest("http://localhost:3000/api/auth/signin/email", {
        method: "POST",
        body: form,
      });
      last = await withSignInRateLimit(req, env, () => Promise.resolve(Response.json({ ok: true })));
      if (i < variants.length) expect(last.status, `variant ${i}`).toBe(200);
    }
    // 5 distinct spellings = 5 consumed units; the canonical 6th is limited.
    expect(last!.status).toBe(429);
  });

  it("route rateLimit accepts per-request key functions (H-110 F6)", async () => {
    const handler = route(async () => Response.json({ ok: true }), {
      rateLimit: {
        key: (req) => `test-client:${req.headers.get("x-client") ?? "anon"}`,
        limit: 1,
        windowSec: 60,
      },
    });
    const call = (client: string) =>
      handler(new Request("http://localhost:3000/api/x", { headers: { "x-client": client } }), undefined);
    expect((await call("a")).status).toBe(200);
    expect((await call("a")).status).toBe(429); // same key: limited
    expect((await call("b")).status).toBe(200); // other key: own bucket
    // The old static-key form still works.
    const staticHandler = route(async () => Response.json({ ok: true }), {
      rateLimit: { key: "static-key-form", limit: 1, windowSec: 60 },
    });
    expect((await staticHandler(new Request("http://localhost:3000/api/x"), undefined)).status).toBe(200);
    expect((await staticHandler(new Request("http://localhost:3000/api/x"), undefined)).status).toBe(429);
  });

  it("auth cookies: httpOnly + sameSite=lax, secure only in production; adapter tokens are single-use", async () => {
    const devOptions = makeAuthOptions(loadEnv());
    const devCookie = devOptions.cookies!.sessionToken!;
    expect(devCookie.name).toBe("next-auth.session-token");
    expect(devCookie.options.httpOnly).toBe(true);
    expect(devCookie.options.sameSite).toBe("lax");
    expect(devCookie.options.secure).toBe(false);

    const prodOptions = makeAuthOptions({
      ...(loadEnv() as never as Record<string, never>),
      NODE_ENV: "production",
      EMAIL_SERVER: "smtp://127.0.0.1:1",
    } as never);
    const prodCookie = prodOptions.cookies!.sessionToken!;
    expect(prodCookie.name).toBe("__Secure-next-auth.session-token");
    expect(prodCookie.options.secure).toBe(true);
    expect(prodCookie.options.httpOnly).toBe(true);
    expect(prodCookie.options.sameSite).toBe("lax");

    // Adapter-level single use: consuming a verification token deletes the
    // row, so a second use of the same link finds nothing (next-auth then
    // rejects the callback). Expired rows are rejected by next-auth's expiry
    // check against the same row.
    const adapter = PrismaAdapter(db);
    await adapter.createVerificationToken!({
      identifier: "single-use@test.example",
      token: "hashed-token-value",
      expires: new Date(Date.now() + 60_000),
    });
    const consumed = await adapter.useVerificationToken!({
      identifier: "single-use@test.example",
      token: "hashed-token-value",
    });
    expect(consumed).not.toBeNull();
    const second = await adapter.useVerificationToken!({
      identifier: "single-use@test.example",
      token: "hashed-token-value",
    });
    expect(second).toBeNull();
    await expect(
      db.verificationToken.findUnique({
        where: { identifier_token: { identifier: "single-use@test.example", token: "hashed-token-value" } },
      }),
    ).resolves.toBeNull();
  });

  it("no token in production logs: the production send path never prints the URL", async () => {
    const prodLogs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      prodLogs.push(args.map(String).join(" "));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const prodOptions = makeAuthOptions({
      ...(loadEnv() as never as Record<string, never>),
      NODE_ENV: "production",
      EMAIL_SERVER: "smtp://127.0.0.1:1",
    } as never);
    const emailProvider = prodOptions.providers.find((p) => (p as { id: string }).id === "email") as unknown as {
      sendVerificationRequest(opts: { identifier: string; url: string; provider: unknown; expires: Date }): Promise<void>;
    };
    const secretUrl = "http://localhost:3000/api/auth/callback/email?token=TOPSECRET-TOKEN&email=a@b.c";
    await expect(
      emailProvider.sendVerificationRequest({ identifier: "a@b.c", url: secretUrl, provider: {}, expires: future(1000) }),
    ).rejects.toThrow();
    expect(prodLogs.join("\n")).not.toContain("TOPSECRET-TOKEN");
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("first-admin bootstrap: INITIAL_ADMIN_EMAIL becomes ADMIN on first sign-in, audit entry written", async () => {
    const env = loadEnv();
    const options = makeAuthOptions({
      ...(env as never as Record<string, never>),
      INITIAL_ADMIN_EMAIL: "boss@test.example",
    } as never);

    // The user row exists (adapter created it during verification).
    const user = await db.user.create({ data: { email: "boss@test.example" } });
    const event = (options.events as { signIn?: (m: { user: { id: string | null; email: string | null } }) => Promise<void> }).signIn;
    await event!({ user: { id: user.id, email: user.email } });

    const promoted = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(promoted.role).toBe("ADMIN");
    const auditRows = await db.auditLog.findMany({ where: { action: "auth.initial_admin_bootstrap" } });
    expect(auditRows).toHaveLength(1);

    // A second sign-in must NOT re-audit (bootstrap happened once).
    await event!({ user: { id: user.id, email: user.email } });
    const rows = await db.auditLog.findMany({ where: { action: "auth.initial_admin_bootstrap" } });
    expect(rows).toHaveLength(1);

    // Another user with the same email cannot bootstrap twice — but a second
    // admin candidate does nothing while an ADMIN exists.
    const second = await db.user.create({ data: { email: "boss2@test.example" } });
    await event!({ user: { id: second.id, email: "BOSS@test.example" } });
    expect((await db.user.findUniqueOrThrow({ where: { id: second.id } })).role).toBe("LISTENER");
  });

  it("authorization matrix: every discovered route is listed and answers as declared", async () => {
    const matrix = JSON.parse(readFileSync("tests/authz-matrix.json", "utf8")) as MatrixFile;
    const actors = matrix.actors;

    // Discover every route.ts under src/app/api.
    const discovered: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/^route\.(ts|tsx)$/.test(e.name)) {
          const rel = relative(join("src", "app", "api"), dirname(p)).split(sep).filter(Boolean);
          const key =
            "/api" +
            (rel.length
              ? "/" + rel.map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ":$1*").replace(/^\[(.+)\]$/, ":$1")).join("/")
              : "");
          discovered.push(key);
        }
      }
    };
    walk(join("src", "app", "api"));
    discovered.sort();

    // Every discovered route must be in the matrix.
    const unknown = discovered.filter((k) => !(k in matrix.routes));
    expect(unknown, `routes missing from tests/authz-matrix.json: ${unknown.join(", ")}`).toEqual([]);

    // Session fixtures per actor.
    const tokens: Record<string, string | null> = { anonymous: null };
    for (const role of ["LISTENER", "ARTIST", "MODERATOR", "ADMIN"] as const) {
      const { user, session } = await createUserWithSession(role);
      tokens[role] = session.sessionToken;
      void user;
    }
    const banned = await createUserWithSession("LISTENER", { banned: true });
    tokens.banned = banned.session.sessionToken;

    for (const key of discovered) {
      const entry = matrix.routes[key as keyof typeof matrix.routes];
      if (entry.skipCall) continue; // public-by-design; flows tested separately

      const mod = await import(`@/app${key === "/api" ? "" : key.replace(":nextauth*", "[...nextauth]")}/route`);
      const handler = mod[entry.method];
      expect(handler, `${entry.method} export missing for ${key}`).toBeTruthy();

      for (const actor of actors) {
        const req = new Request(`http://localhost:3000${key.replace(/:\w+\*/, "x")}`, {
          method: entry.method,
          headers: tokens[actor] ? { cookie: `${SESSION_COOKIE}=${tokens[actor]}` } : {},
        });
        const res = await handler(req, { params: Promise.resolve({}) });
        expect(res.status, `${entry.method} ${key} as ${actor}`).toBe(
          entry.expected[actor as keyof typeof entry.expected],
        );
      }
    }
  });
});
