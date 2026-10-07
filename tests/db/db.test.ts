import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { cleanTables, databaseUrl, makeClient, skipMessage } from "./helpers";
import { seed } from "../../prisma/seed";
import { purgeExpiredBuckets, rateLimit } from "@/server/ratelimit";
import { endCurrentSlotEarly, startScheduler } from "@/server/broadcast/scheduler";
import { radioNow } from "@/app/api/radio/now/route";

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
