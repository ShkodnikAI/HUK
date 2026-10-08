// Pure timeline math (H-104, ADR-0004): pool quota, no-repeat window, gapless
// filling. No database, no clock, no globals — the RNG is injected so the
// behaviour is property-testable and deterministic under a seed.
// H-304: the fresh pool picks by Thompson sampling from Beta(likes+1,
// dislikes+1) (betaSample is pure and imported from the ranking module).

import { betaSample } from "@/server/ranking/signals";

export type PoolName = "top" | "fresh" | "rest";

/** A track the scheduler may pick; pools are resolved by the caller. */
export interface SchedulableTrack {
  id: string;
  durationSec: number;
  pool: PoolName;
  /**
   * H-304: Beta(likes + 1, dislikes + 1) for the fresh pool's Thompson
   * sampling. Absent → uniform pick within the pool (unchanged behaviour).
   */
  beta?: { alpha: number; beta: number };
}

export type Rng = () => number; // uniform [0, 1)

/** Quota per pool (ARCHITECTURE §5: ~40% top / ~40% fresh / ~20% rest). */
export const QUOTA: Record<PoolName, number> = { top: 0.4, fresh: 0.4, rest: 0.2 };

/** No-repeat window: never schedule a track again within these bounds. */
export const NO_REPEAT_TRACKS = 20;
export const NO_REPEAT_MS = 60 * 60 * 1000;

/** One planned slot (times as epoch ms to keep the math pure). */
export interface PlannedSlot {
  trackId: string;
  startsAt: number;
  endsAt: number;
}

/** mulberry32: small seeded generator for deterministic tests. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `recent` is the ordered no-repeat window: ids from oldest to newest play.
 * The scheduler must not repeat an id while it is in the window; when the
 * library is smaller than the window (e.g. 9 seed tracks), it falls back to
 * least-recently-used so the timeline never starves (documented in H-104).
 */
export function pickNext(opts: {
  candidates: SchedulableTrack[];
  /** Ordered oldest → newest; may exceed NO_REPEAT_TRACKS (caller owns trimming). */
  recent: readonly string[];
  rng: Rng;
}): SchedulableTrack | null {
  const { candidates, recent, rng } = opts;
  if (candidates.length === 0) return null;

  const recentSet = new Set(recent);
  const available = candidates.filter((t) => !recentSet.has(t.id));

  const byPool = (pool: PoolName, list: SchedulableTrack[]) =>
    list.filter((t) => t.pool === pool);

  if (available.length > 0) {
    const roll = rng();
    for (const pool of quotaOrder(roll)) {
      const poolCandidates = byPool(pool, available);
      if (poolCandidates.length > 0) {
        // H-304: the fresh pool picks by Thompson sampling from each
        // track's Beta posterior; the other pools stay uniform.
        if (pool === "fresh" && poolCandidates.some((t) => t.beta)) {
          let best: SchedulableTrack | null = null;
          let bestTheta = -1;
          for (const track of poolCandidates) {
            const theta = track.beta ? betaSample(track.beta.alpha, track.beta.beta, rng) : rng();
            if (theta > bestTheta) {
              best = track;
              bestTheta = theta;
            }
          }
          return best ?? poolCandidates[0];
        }
        return poolCandidates[Math.floor(rng() * poolCandidates.length) % poolCandidates.length];
      }
    }
    return null; // unreachable: quotaOrder is exhaustive and available is non-empty
  }

  // LRU fallback (library smaller than the window): never-played tracks do
  // not exist here, so pick the candidate whose last play is the oldest.
  const lastPlayed = new Map<string, number>();
  recent.forEach((id, index) => lastPlayed.set(id, index));
  let best: SchedulableTrack | null = null;
  let bestIndex = Infinity;
  for (const track of candidates) {
    const index = lastPlayed.get(track.id) ?? -1;
    if (index < bestIndex) {
      best = track;
      bestIndex = index;
    }
  }
  return best;
}

/**
 * Pool preference order for a quota roll. An EMPTY pool's share falls to
 * `rest` first (H-104: "top … empty until H-304, then falls back to rest"),
 * then to the remaining pools.
 */
export function quotaOrder(roll: number): PoolName[] {
  if (roll < QUOTA.top) return ["top", "rest", "fresh"];
  if (roll < QUOTA.top + QUOTA.fresh) return ["fresh", "rest", "top"];
  return ["rest", "fresh", "top"];
}

/**
 * Fills the timeline from `fromMs` up to `untilMs` (slots must end before the
 * horizon): consecutive slots, no gaps, no overlaps, durations positive.
 * `recent` is ordered oldest → newest; newly planned ids are appended (never
 * trimmed inside the call — the caller re-reads the window from the DB).
 */
export function fillSlots(opts: {
  candidates: SchedulableTrack[];
  recent: readonly string[];
  fromMs: number;
  untilMs: number;
  rng: Rng;
}): PlannedSlot[] {
  const { candidates, fromMs, untilMs, rng } = opts;
  const recent: string[] = [...opts.recent];
  const slots: PlannedSlot[] = [];

  let cursor = Math.max(0, fromMs);
  while (cursor < untilMs) {
    const track = pickNext({ candidates, recent, rng });
    if (track === null) break; // nothing schedulable at all
    const durationMs = Math.max(1, Math.round(track.durationSec * 1000));
    const endsAt = cursor + durationMs;
    slots.push({ trackId: track.id, startsAt: cursor, endsAt });
    recent.push(track.id);
    cursor = endsAt;
  }
  return slots;
}
