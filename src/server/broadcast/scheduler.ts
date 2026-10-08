// Broadcast scheduler (H-104, ADR-0004): a single writer owns BroadcastSlot.
// Leadership is a Postgres session advisory lock held on a DEDICATED pg
// connection (session-scoped, so the lock lives as long as the connection);
// other scheduler instances idle and retry each tick. The lock is released on
// shutdown so failover is immediate.

import { Client } from "pg";
import { loadEnv, type Env } from "@/server/env";
import { db } from "@/server/db";
import { fillSlots, NO_REPEAT_MS, NO_REPEAT_TRACKS, type PoolName, type Rng } from "./timeline";

/** Dedicated advisory-lock key for the broadcast timeline (arbitrary, stable). */
export const BROADCAST_LOCK_KEY = 741_128_003;

/** The scheduler keeps at least this much future timeline filled. */
export const HORIZON_MS = 30 * 60 * 1000;

/** Size of the `fresh` pool (newest approved tracks) — assumption in the PR. */
export const FRESH_POOL_SIZE = 25;

export interface SchedulerOptions {
  tickMs?: number;
  rng?: Rng;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
}

export interface SchedulerHandle {
  stop(): Promise<void>;
  /** Resolves with true if this instance ever held the lock. */
  done(): Promise<boolean>;
  isLeader(): boolean;
}

interface Candidate {
  id: string;
  durationSec: number;
  pool: PoolName;
}

/** Tracks eligible for scheduling: S2 — only APPROVED and available. */
async function loadCandidates(): Promise<Candidate[]> {
  // top: highest TrackScore for categoryKey 'all' (empty until H-304);
  // fresh: the newest approved tracks (FRESH_POOL_SIZE, assumption documented
  // in the PR); rest: everything else.
  const topRows = await db.trackScore.findMany({
    where: { categoryKey: "all" },
    orderBy: { score: "desc" },
    take: 50,
    select: { trackId: true },
  });
  const topIds = new Set(topRows.map((r) => r.trackId));

  const tracks = await db.track.findMany({
    where: { status: "APPROVED", available: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, durationSec: true },
  });
  const freshIds = new Set(tracks.slice(0, FRESH_POOL_SIZE).map((t) => t.id));

  return tracks.map((t) => ({
    id: t.id,
    durationSec: t.durationSec,
    pool: topIds.has(t.id) ? "top" : freshIds.has(t.id) ? "fresh" : "rest",
  }));
}

/** No-repeat window state: ids of the last 20 slots plus slots ended after now-60min, oldest first. */
async function recentTrackIds(nowMs: number): Promise<string[]> {
  const rows = await db.broadcastSlot.findMany({
    where: { endsAt: { gt: new Date(nowMs - NO_REPEAT_MS) } },
    orderBy: { startsAt: "asc" },
    select: { trackId: true },
  });
  return rows.slice(-Math.max(NO_REPEAT_TRACKS, 1)).map((r) => r.trackId);
}

export function startScheduler(opts: SchedulerOptions = {}): SchedulerHandle {
  const tickMs = opts.tickMs ?? 1000;
  const rng = opts.rng ?? Math.random;
  const now = opts.now ?? Date.now;
  const env: Env = loadEnv();

  let stopped = false;
  let leader = false;
  let everLeader = false;
  let lockClient: Client | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stoppedDeferred: (() => void) | null = null;
  const donePromise = new Promise<boolean>((resolve) => {
    stoppedDeferred = () => resolve(everLeader);
  });

  async function acquireLock(): Promise<boolean> {
    const client = new Client({ connectionString: env.DATABASE_URL });
    await client.connect();
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS ok", [BROADCAST_LOCK_KEY]);
    if (res.rows[0]?.ok === true) {
      lockClient = client;
      leader = true;
      everLeader = true;
      return true;
    }
    await client.end();
    return false;
  }

  async function releaseLock(): Promise<void> {
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [BROADCAST_LOCK_KEY]);
      } finally {
        await lockClient.end();
        lockClient = null;
      }
    }
    leader = false;
  }

  async function leaderTick(): Promise<void> {
    const nowMs = now();

    // H-212 (G2/G3) self-heal, every tick: drop orphan slots of tracks that
    // are no longer public (not APPROVED or unavailable). The live slot ends
    // now, future slots are deleted; the normal fill below repairs the hole
    // in the same tick. Safety net for paths nobody remembers.
    const nowDate = new Date(nowMs);
    await db.broadcastSlot.updateMany({
      where: {
        startsAt: { lte: nowDate },
        endsAt: { gt: nowDate },
        track: { OR: [{ status: { not: "APPROVED" } }, { available: false }] },
      },
      data: { endsAt: nowDate },
    });
    await db.broadcastSlot.deleteMany({
      where: {
        startsAt: { gt: nowDate },
        track: { OR: [{ status: { not: "APPROVED" } }, { available: false }] },
      },
    });

    const candidates = await loadCandidates();

    // Walk the live timeline (chronological by startsAt) and find the first
    // uncovered moment: a hole left by endCurrentSlotEarly, or simply the end
    // of the planned future. Holes are filled first, bounded by the start of
    // the next existing slot so the timeline never overlaps.
    const live = await db.broadcastSlot.findMany({
      where: { endsAt: { gt: new Date(nowMs) } },
      orderBy: { startsAt: "asc" },
    });

    let expected = nowMs;
    let nextExistingStart: number | null = null;
    for (const slot of live) {
      const start = slot.startsAt.getTime();
      if (start > expected) {
        nextExistingStart = start;
        break; // hole at [expected, start)
      }
      expected = Math.max(expected, slot.endsAt.getTime());
    }

    const horizon = nowMs + HORIZON_MS;
    const from = expected;
    const until = Math.min(horizon, nextExistingStart ?? horizon);

    if (from < until) {
      const recent = await recentTrackIds(nowMs);
      const slots = fillSlots({
        candidates,
        recent,
        fromMs: from,
        untilMs: until,
        rng,
      });
      if (slots.length > 0) {
        // Single writer ⇒ reading lastSeq and writing the batch is safe.
        const station = await db.stationState.upsert({
          where: { id: "main" },
          update: {},
          create: { id: "main" },
        });
        let seq = station.lastSeq;
        await db.broadcastSlot.createMany({
          data: slots.map((s) => ({
            seq: ++seq,
            trackId: s.trackId,
            startsAt: new Date(s.startsAt),
            endsAt: new Date(s.endsAt),
          })),
        });
        await db.stationState.update({
          where: { id: "main" },
          data: { lastSeq: seq, workerBeat: new Date(nowMs) },
        });
        return;
      }
    }

    await db.stationState.upsert({
      where: { id: "main" },
      update: { workerBeat: new Date(nowMs) },
      create: { id: "main", workerBeat: new Date(nowMs) },
    });
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      if (!leader) {
        const got = await acquireLock();
        if (!got) return; // follower: idle and retry next tick
      }
      await leaderTick();
    } catch (error) {
      console.error("[broadcast] tick failed:", error);
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, tickMs);
    timer.unref?.();
  }

  void tick()
    .then(schedule)
    .catch((error) => console.error("[broadcast] startup tick failed:", error));

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await releaseLock();
      stoppedDeferred?.();
    },
    done: () => donePromise,
    isLeader: () => leader,
  };
}

/**
 * Ends the currently playing slot of `trackId` early (takedown/unavailable —
 * ARCHITECTURE §5). The leader notices the shortened endsAt on its next tick
 * and fills the gap. Returns the affected slot, if any.
 */
export async function endCurrentSlotEarly(trackId: string, at: Date = new Date()) {
  const slot = await db.broadcastSlot.findFirst({
    where: { trackId, startsAt: { lte: at }, endsAt: { gt: at } },
    orderBy: { seq: "asc" },
  });
  if (!slot) return null;
  return db.broadcastSlot.update({
    where: { seq: slot.seq },
    data: { endsAt: at },
  });
}
