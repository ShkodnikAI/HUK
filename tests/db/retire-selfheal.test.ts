import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanTables, databaseUrl, makeClient } from "./helpers";
import { startScheduler } from "@/server/broadcast/scheduler";
import { retireTrackFromAir } from "@/server/broadcast/retire";
import { takedownTrack } from "@/server/tracks/takedown";
import { verifyTrackSource } from "@/server/sources/verify";
import type { SafeLoader } from "@/server/net/safe-fetch";
import { SafeFetchError } from "@/server/net/safe-fetch";
import { radioNow } from "@/app/api/radio/now/route";

// H-212 (G2/G3): every path that takes a track off the air ends its live
// slot and deletes its future slots; the scheduler self-heals orphan slots
// within one tick. Real Postgres, real scheduler, fake source transport
// (the H-201 loader seam).

describe.skipIf(!databaseUrl)("retire from air + scheduler self-heal (H-212)", () => {
  const db = makeClient();
  beforeAll(async () => {
    if (databaseUrl) {
      // Migrations are deployed by CI; ensure the client can connect.
      await db.$connect();
    }
  });
  afterAll(async () => {
    if (databaseUrl) await db.$disconnect();
  });

  beforeEach(async () => {
    // The scheduler uses the db.ts singleton, which needs AUTH_SECRET.
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    await cleanTables(db);
  });

  afterEach(async () => {
    await cleanTables(db);
  });

  async function pollUntil(cond: () => Promise<boolean> | boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await cond()) return true;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return (await cond()) === true;
  }

  /** One APPROVED track with a DIRECT_URL source (etag/length recorded). */
  async function trackWithSource(opts?: { etag?: string | null; byteLength?: bigint; failCount?: number }) {
    const track = await db.track.create({
      data: { title: "on air", status: "APPROVED", available: true, durationSec: 60 },
    });
    await db.trackSource.create({
      data: {
        trackId: track.id,
        provider: "DIRECT_URL",
        url: "https://author-host.test/file.mp3",
        etag: opts?.etag ?? '"v1"',
        byteLength: opts?.byteLength ?? 100n,
        failCount: opts?.failCount ?? 0,
      },
    });
    return track;
  }

  /** Live slot covering now + two future slots, exactly what G2 described.
   * seq values are far above anything the scheduler generates (lastSeq
   * starts at 0), so planted fixtures never collide with fresh slots. */
  async function plantSlots(trackId: string) {
    const nowMs = Date.now();
    await db.broadcastSlot.createMany({
      data: [
        { seq: 1_000_001n, trackId, startsAt: new Date(nowMs - 10_000), endsAt: new Date(nowMs + 30_000) },
        { seq: 1_000_002n, trackId, startsAt: new Date(nowMs + 60_000), endsAt: new Date(nowMs + 120_000) },
        { seq: 1_000_003n, trackId, startsAt: new Date(nowMs + 180_000), endsAt: new Date(nowMs + 240_000) },
      ],
    });
  }

  it("retireTrackFromAir ends the live slot and deletes all future slots in one transaction", async () => {
    const track = await trackWithSource();
    await plantSlots(track.id);

    const before = new Date();
    const result = await retireTrackFromAir(track.id, before, db);

    expect(result.ended).not.toBeNull();
    expect(result.futureDeleted).toBe(2);
    const slots = await db.broadcastSlot.findMany({ where: { trackId: track.id } });
    expect(slots).toHaveLength(1);
    expect(slots[0].startsAt.getTime()).toBeLessThanOrEqual(before.getTime());
    expect(slots[0].endsAt.getTime()).toBeLessThanOrEqual(before.getTime());
  });

  it("a hash mismatch suspends the track, retires its slots and the leader refills within a tick", async () => {
    const track = await trackWithSource({ etag: '"v1"', byteLength: 100n });
    await plantSlots(track.id);
    // A second approved track so the scheduler has something to fill with.
    const filler = await db.track.create({
      data: { title: "filler", status: "APPROVED", available: true, durationSec: 60 },
    });
    await db.trackSource.create({ data: { trackId: filler.id, provider: "SEED", url: "https://seed.test/f.mp3" } });

    // The H-201 seams: the resolver pins TEST-NET-3 (classification-safe),
    // the probe answers with a changed ETag.
    const changedLoader: SafeLoader = async (req) => ({
      status: 200,
      headers: { etag: '"changed"', "content-length": "100" },
      body: null,
      bytes: 0,
      url: req.url.toString(),
    });

    const scheduler = startScheduler({ tickMs: 100 });
    try {
      const outcome = await verifyTrackSource(track.id, {
        client: db,
        loader: changedLoader,
        resolver: async () => ["203.0.113.10"],
      });
      expect(outcome.outcome).toBe("mismatch");

      const suspended = await db.track.findUniqueOrThrow({ where: { id: track.id } });
      expect(suspended.status).toBe("SUSPENDED");

      // Retired by the verify call itself: no future slots, no live slot
      // covering "now" (the ended live row may remain with endsAt = t).
      const leftover = await db.broadcastSlot.count({
        where: { trackId: track.id, endsAt: { gt: new Date() } },
      });
      expect(leftover).toBe(0);

      // The leader fills the hole within a tick (poll, CI-tolerant).
      const refilled = await pollUntil(async () => {
        const body = await radioNow(Date.now(), db);
        return body.current !== null;
      }, 10_000);
      expect(refilled).toBe(true);
    } finally {
      await scheduler.stop().catch(() => {});
    }
  }, 30_000);

  it("an unavailable source (SOURCE_MAX_FAILS reached) leaves the air: slots retired in the same call", async () => {
    const track = await trackWithSource({ failCount: 0 });
    await plantSlots(track.id);

    const refusedLoader: SafeLoader = async () => {
      throw new SafeFetchError("DNS_FAILED", "connection refused (test)");
    };

    const outcome = await verifyTrackSource(track.id, {
      client: db,
      loader: refusedLoader,
      resolver: async () => ["203.0.113.10"],
      env: { SOURCE_FULL_HASH_DAYS: 7, SOURCE_MAX_FAILS: 1, AUDIUS_ENABLED: false },
    });
    expect(outcome.outcome).toBe("unavailable");

    const after = await db.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(after.available).toBe(false);
    const leftover = await db.broadcastSlot.count({
      where: { trackId: track.id, endsAt: { gt: new Date() } },
    });
    expect(leftover).toBe(0);
  });

  it("planted orphan slots (live and future) of an ineligible track are healed within one tick", async () => {
    // The ineligible track: suspended but its slots were never retired —
    // exactly the G2 state the self-heal exists for.
    const orphan = await db.track.create({
      data: { title: "orphan", status: "SUSPENDED", available: true, durationSec: 60 },
    });
    await plantSlots(orphan.id);
    // Fillers so the hole left by the heal gets repaired.
    for (let i = 0; i < 3; i++) {
      const t = await db.track.create({
        data: { title: `filler ${i}`, status: "APPROVED", available: true, durationSec: 60 },
      });
      await db.trackSource.create({ data: { trackId: t.id, provider: "SEED", url: `https://seed.test/${i}.mp3` } });
    }

    const scheduler = startScheduler({ tickMs: 100 });
    try {
      const healed = await pollUntil(async () => {
        const nowMs = Date.now();
        const future = await db.broadcastSlot.count({ where: { trackId: orphan.id, startsAt: { gt: new Date(nowMs) } } });
        const live = await db.broadcastSlot.count({
          where: { trackId: orphan.id, startsAt: { lte: new Date(nowMs) }, endsAt: { gt: new Date(nowMs) } },
        });
        return future === 0 && live === 0;
      }, 10_000);
      expect(healed).toBe(true);

      // The station stays alive: the hole is refilled within the same tick.
      const alive = await pollUntil(async () => {
        const body = await radioNow(Date.now(), db);
        return body.current !== null;
      }, 10_000);
      expect(alive).toBe(true);
    } finally {
      await scheduler.stop().catch(() => {});
    }
  }, 30_000);

  it("takedownTrack keeps its contract: slots retired atomically, second call is a no-op", async () => {
    const track = await trackWithSource();
    await plantSlots(track.id);

    const first = await takedownTrack(track.id, "confirmed fraud", null, { client: db });
    expect(first.noop).toBe(false);
    const after = await db.track.findUniqueOrThrow({ where: { id: track.id } });
    expect(after.status).toBe("TAKEN_DOWN");
    // No slot survives beyond the takedown moment (the ended live row may
    // remain with endsAt = t, future slots are gone).
    const leftover = await db.broadcastSlot.count({
      where: { trackId: track.id, endsAt: { gt: new Date() } },
    });
    expect(leftover).toBe(0);
    expect(await db.auditLog.count({ where: { action: "track.taken-down", targetId: track.id } })).toBe(1);

    const second = await takedownTrack(track.id, "again", null, { client: db });
    expect(second.noop).toBe(true);
    expect(await db.auditLog.count({ where: { action: "track.taken-down", targetId: track.id } })).toBe(1);
  });
});
