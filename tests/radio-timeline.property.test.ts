import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  fillSlots,
  NO_REPEAT_TRACKS,
  pickNext,
  QUOTA,
  seededRng,
  type PoolName,
  type SchedulableTrack,
} from "@/server/broadcast/timeline";

// H-104 property tests (fast-check): the timeline math is gapless and
// overlap-free for any durations; quota holds within tolerance over 10 000
// picks; the no-repeat window is respected; only schedulable tracks are
// picked; an empty library yields no slots.

function makeLibrary(n: number, minSec = 30, maxSec = 300): SchedulableTrack[] {
  const rng = seededRng(n * 7919);
  const pools: PoolName[] = ["top", "fresh", "rest"];
  return Array.from({ length: n }, (_, i) => ({
    id: `track-${i}`,
    durationSec: minSec + rng() * (maxSec - minSec),
    pool: pools[i % pools.length],
  }));
}

describe("fillSlots (H-104)", () => {
  it("produces gapless, overlap-free slots for arbitrary durations", () => {
    const arb = fc
      .array(fc.integer({ min: 1, max: 600 }), { minLength: 1, maxLength: 40 })
      .map((durations) =>
        durations.map((d, i) => ({
          id: `t${i}-${d}`,
          durationSec: d,
          pool: (["top", "fresh", "rest"] as PoolName[])[i % 3],
        })),
      );

    fc.assert(
      fc.property(
        arb,
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 1, max: 60_000 }),
        (library, from, horizon) => {
          const slots = fillSlots({
            candidates: library,
            recent: [],
            fromMs: from,
            untilMs: from + horizon,
            rng: seededRng(horizon + library.length),
          });
          let cursor = from;
          for (const slot of slots) {
            if (slot.startsAt !== cursor) return false; // gap or overlap
            if (slot.endsAt <= slot.startsAt) return false; // non-positive duration
            cursor = slot.endsAt;
          }
          return true;
        },
      ),
    );
  });

  it("plans nothing for an empty library", () => {
    const slots = fillSlots({
      candidates: [],
      recent: [],
      fromMs: 0,
      untilMs: 60_000,
      rng: seededRng(1),
    });
    expect(slots).toEqual([]);
  });

  it("respects the no-repeat window when the library is large enough", () => {
    const library = makeLibrary(NO_REPEAT_TRACKS * 3);
    const slots = fillSlots({
      candidates: library,
      recent: [],
      fromMs: 0,
      untilMs: 30 * 60 * 1000,
      rng: seededRng(42),
    });

    const recent: string[] = [];
    for (const slot of slots) {
      expect(recent.slice(-NO_REPEAT_TRACKS)).not.toContain(slot.trackId);
      recent.push(slot.trackId);
    }
  });

  it("keeps slots contiguous across repeated fills (no gaps between calls)", () => {
    const library = makeLibrary(60);
    let recent: string[] = [];
    let cursor = 0;
    for (let round = 0; round < 3; round++) {
      const slots = fillSlots({
        candidates: library,
        recent,
        fromMs: cursor,
        untilMs: cursor + 5 * 60 * 1000,
        rng: seededRng(1000 + round),
      });
      for (const slot of slots) {
        expect(slot.startsAt).toBe(cursor);
        cursor = slot.endsAt;
      }
      recent = [...recent, ...slots.map((s) => s.trackId)];
    }
  });
});

describe("pickNext quota (H-104)", () => {
  it("keeps the 40/40/20 quota within tolerance over 10 000 picks", () => {
    const library: SchedulableTrack[] = Array.from({ length: 60 }, (_, i) => ({
      id: `t${i}`,
      durationSec: 180,
      pool: (["top", "fresh", "rest"] as PoolName[])[i % 3],
    }));
    const counts: Record<PoolName, number> = { top: 0, fresh: 0, rest: 0 };
    const recent: string[] = [];
    const rng = seededRng(20261007);

    for (let i = 0; i < 10_000; i++) {
      const track = pickNext({ candidates: library, recent, rng });
      expect(track).not.toBeNull();
      counts[track!.pool]++;
      recent.push(track!.id);
      // keep the window semantics: the caller trims to the last 20
      if (recent.length > NO_REPEAT_TRACKS) recent.shift();
    }

    for (const pool of ["top", "fresh", "rest"] as PoolName[]) {
      const share = counts[pool] / 10_000;
      expect(Math.abs(share - QUOTA[pool])).toBeLessThan(0.02);
    }
  });

  it("routes an empty top pool's share to rest: fresh ≈ 40%, rest ≈ 60%", () => {
    // No 'top' tracks at all (TrackScore table empty until H-304).
    const library: SchedulableTrack[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ id: `f${i}`, durationSec: 60, pool: "fresh" as PoolName })),
      ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, durationSec: 60, pool: "rest" as PoolName })),
    ];
    const counts = { top: 0, fresh: 0, rest: 0 };
    const recent: string[] = [];
    const rng = seededRng(7);

    for (let i = 0; i < 10_000; i++) {
      const track = pickNext({ candidates: library, recent, rng });
      expect(track).not.toBeNull();
      counts[track!.pool]++;
      recent.push(track!.id);
      if (recent.length > NO_REPEAT_TRACKS) recent.shift();
    }

    expect(counts.top).toBe(0);
    expect(Math.abs(counts.fresh / 10_000 - 0.4)).toBeLessThan(0.02);
    expect(Math.abs(counts.rest / 10_000 - 0.6)).toBeLessThan(0.02);
  });

  it("never picks a track outside the candidate list", () => {
    const library = makeLibrary(30);
    const recent: string[] = [];
    const rng = seededRng(99);
    for (let i = 0; i < 500; i++) {
      const track = pickNext({ candidates: library, recent, rng });
      expect(track).not.toBeNull();
      expect(library.some((t) => t.id === track!.id)).toBe(true);
      recent.push(track!.id);
      if (recent.length > NO_REPEAT_TRACKS) recent.shift();
    }
  });

  it("returns null only when there is nothing schedulable at all", () => {
    expect(pickNext({ candidates: [], recent: [], rng: seededRng(1) })).toBeNull();
  });
});
