import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { seededRng } from "@/server/broadcast/timeline";
import { pickNext, type SchedulableTrack } from "@/server/broadcast/timeline";
import {
  betaSample,
  eventWeight,
  HALF_LIFE_MS,
  MIN_VOTERS,
  scoreTrack,
  SIGNAL_WEIGHTS,
  wilsonLowerBound,
  type RankedEvent,
} from "@/server/ranking/signals";

// H-304 contracts (pure math): weights match the table, decay strictly
// reduces old events, scores are monotone in positives and anti-monotone
// in negatives, identical input gives identical output, 5-of-5 ranks below
// 199-of-200, and Thompson sampling favours a strong track (seeded).

const like = (actorId: string, ageMs = 0, reputation = 1): RankedEvent => ({
  type: "LIKE",
  reputation,
  ageMs,
  actorId,
});

describe("event weights (H-304)", () => {
  it("matches the signal table", () => {
    expect(SIGNAL_WEIGHTS.LIKE).toBe(1);
    expect(SIGNAL_WEIGHTS.DISLIKE).toBe(-1);
    expect(SIGNAL_WEIGHTS.PLAYLIST_ADD).toBe(1.5);
    expect(SIGNAL_WEIGHTS.COMPLETION).toBe(0.5);
    expect(SIGNAL_WEIGHTS.REPEAT_COMPLETION).toBe(0.5);
    expect(SIGNAL_WEIGHTS.EARLY_SKIP_PLAYLIST).toBe(-0.5);
    expect(eventWeight("LIKE", 1, 0)).toBe(1);
    expect(eventWeight("PLAYLIST_ADD", 1, 0)).toBe(1.5);
    expect(eventWeight("DISLIKE", 1, 0)).toBe(-1);
  });

  it("decays strictly: an older event weighs strictly less (same sign)", () => {
    const fresh = eventWeight("LIKE", 1, 0);
    const half = eventWeight("LIKE", 1, HALF_LIFE_MS);
    expect(half).toBeCloseTo(0.5, 12);
    expect(Math.abs(eventWeight("LIKE", 1, 3 * HALF_LIFE_MS))).toBeLessThan(Math.abs(half));
    expect(fresh).toBeGreaterThan(half);
    // reputation scales linearly
    expect(eventWeight("LIKE", 0.5, 0)).toBeCloseTo(0.5, 12);
  });
});

describe("wilson lower bound (H-304)", () => {
  it("5 of 5 positives rank below 199 of 200", () => {
    expect(wilsonLowerBound(5, 5)).toBeLessThan(wilsonLowerBound(199, 200));
  });

  it("monotone in positives, anti-monotone in negatives (property)", () => {
    const positiveArb = fc.integer({ min: 10, max: 500 });
    const negativeArb = fc.integer({ min: 0, max: 100 });
    fc.assert(
      fc.property(positiveArb, positiveArb.filter((n) => n > 0), negativeArb, (p, pMore, n) => {
        fc.pre(pMore >= p);
        expect(wilsonLowerBound(pMore, pMore + n)).toBeGreaterThanOrEqual(wilsonLowerBound(p, p + n));
        expect(wilsonLowerBound(p, p + n + 5)).toBeLessThanOrEqual(wilsonLowerBound(p, p + n));
      }),
    );
  });

  it("clamps to [0, 1] and is 0 for N = 0", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(10, 10)).toBeLessThanOrEqual(1);
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });
});

describe("scoreTrack (H-304)", () => {
  it("deterministic: identical input gives identical output", () => {
    const events = Array.from({ length: 12 }, (_, i) => like(`u${i}`, i * 1000));
    const a = scoreTrack(events);
    const b = scoreTrack([...events].reverse());
    expect(a).toEqual(b);
  });

  it("below MIN_VOTERS the score is 0; at the threshold it is positive", () => {
    const few = Array.from({ length: MIN_VOTERS - 1 }, (_, i) => like(`u${i}`));
    expect(scoreTrack(few).score).toBe(0);
    const enough = Array.from({ length: MIN_VOTERS }, (_, i) => like(`u${i}`));
    expect(scoreTrack(enough).score).toBeGreaterThan(0);
    expect(scoreTrack(enough).voters).toBe(MIN_VOTERS);
  });

  it("monotone in positives and anti-monotone in negatives; flagged events weigh 0", () => {
    const base = Array.from({ length: MIN_VOTERS }, (_, i) => like(`u${i}`));
    const withExtra = [...base, like("extra")];
    expect(scoreTrack(withExtra).score).toBeGreaterThanOrEqual(scoreTrack(base).score);

    const withDislike = [...base, { type: "DISLIKE" as const, reputation: 1, ageMs: 0, actorId: "hater" }];
    expect(scoreTrack(withDislike).score).toBeLessThan(scoreTrack(base).score);

    const flaggedBurst = [...base, { type: "LIKE" as const, reputation: 1, ageMs: 0, actorId: "burst", flagged: true }];
    // A flagged vote adds neither weight nor a voter.
    expect(scoreTrack(flaggedBurst).score).toBe(scoreTrack(base).score);
    expect(scoreTrack(flaggedBurst).voters).toBe(MIN_VOTERS);
  });
});

describe("thompson sampling for the fresh pool (H-304)", () => {
  const track = (id: string, beta?: { alpha: number; beta: number }): SchedulableTrack => ({
    id,
    durationSec: 60,
    pool: "fresh",
    beta,
  });

  it("a strong track is picked more often than a weak one; a no-data track still gets picked (fixed seed)", () => {
    const strong = track("strong", { alpha: 40, beta: 2 });
    const weak = track("weak", { alpha: 2, beta: 40 });
    const noData = track("nodata", { alpha: 1, beta: 1 });
    const counts = new Map<string, number>([
      ["strong", 0],
      ["weak", 0],
      ["nodata", 0],
    ]);
    const rng = seededRng(20261008);
    for (let i = 0; i < 3000; i++) {
      const picked = pickNext({ candidates: [strong, weak, noData], recent: [], rng });
      expect(picked).not.toBeNull();
      counts.set(picked!.id, (counts.get(picked!.id) ?? 0) + 1);
    }
    expect(counts.get("strong")!).toBeGreaterThan(counts.get("weak")! * 5);
    expect(counts.get("nodata")!).toBeGreaterThan(0); // exploration
  });

  it("betaSample stays in [0, 1] and the mean approximates alpha/(alpha+beta)", () => {
    const rng = seededRng(42);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const x = betaSample(8, 2, rng);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1);
      sum += x;
    }
    expect(sum / n).toBeGreaterThan(0.72); // alpha/(alpha+beta) = 0.8, loose bound
    expect(sum / n).toBeLessThan(0.88);
  });
});

// ───────────────────────── H-307 — determinism under shuffling ─────────────────────────
// Float summation is not associative: without a canonical order, shuffling
// the input events could change the score in the last bits. scoreTrack now
// sorts internally, so ANY permutation of the same events must yield a
// bit-identical result.

const H307_TYPES = ["LIKE", "DISLIKE", "PLAYLIST_ADD", "COMPLETION", "REPEAT_COMPLETION", "EARLY_SKIP_PLAYLIST"] as const;

const h307EventArb = fc
  .record({
    type: fc.constantFrom(...H307_TYPES),
    reputation: fc.float({ min: Math.fround(0.2), max: 1, noNaN: true }),
    ageMs: fc.nat({ max: 30 * 24 * 60 * 60 * 1000 }),
    actorId: fc.string({ minLength: 1, maxLength: 8 }),
    flagged: fc.boolean(),
  })
  .map((e) => e as RankedEvent);

/** Deterministic Fisher-Yates (mulberry32) — the seed comes from fc. */
function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe("scoreTrack order-insensitivity (H-307)", () => {
  it("a shuffled event list scores bit-identically to the original (property)", () => {
    fc.assert(
      fc.property(
        fc.array(h307EventArb, { minLength: 0, maxLength: 80 }),
        fc.nat({ max: 2 ** 31 - 1 }),
        (events, seed) => {
          const shuffled = seededShuffle(events, seed);
          const a = scoreTrack(events);
          const b = scoreTrack(shuffled);
          expect(Object.is(b.score, a.score)).toBe(true);
          expect(Object.is(b.nEff, a.nEff)).toBe(true);
          expect(b.voters).toBe(a.voters);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("10 000 events recompute in well under 1 s (pure scoring cost)", () => {
    const events: RankedEvent[] = Array.from({ length: 10_000 }, (_, i) => ({
      type: i % 3 === 0 ? "LIKE" : i % 3 === 1 ? "COMPLETION" : "EARLY_SKIP_PLAYLIST",
      reputation: 0.2 + (i % 80) / 100,
      ageMs: (i % 700) * 60_000,
      actorId: `actor-${i % 500}`,
    }));
    const t0 = performance.now();
    const result = scoreTrack(events);
    const elapsed = performance.now() - t0;
    expect(result.voters).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1000);
  });
});
