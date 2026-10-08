// Ranking math (H-304, ARCHITECTURE §9, ADR-0006) — PURE functions, no DB,
// no clock: every input is a parameter, so everything is property-testable.
//
// Signals are weighted by type and user reputation, then decayed by a
// 7-day half-life. The score is a Wilson lower bound over the decayed
// weighted positives and negatives (continuity-corrected for small n) —
// an optimistic track with few votes ranks below a proven one. Dislikes
// lower the score; they never remove a track from the air and are never
// shown publicly. Flagged (anti-fraud) events weigh exactly 0.

/** The signal table in one config object (weights per event). */
export type SignalType =
  | "LIKE"
  | "DISLIKE"
  | "PLAYLIST_ADD"
  | "COMPLETION"
  | "REPEAT_COMPLETION"
  | "EARLY_SKIP_PLAYLIST";

export const SIGNAL_WEIGHTS: Readonly<Record<SignalType, number>> = {
  LIKE: 1,
  DISLIKE: -1,
  PLAYLIST_ADD: 1.5,
  COMPLETION: 0.5, // >= 80 % of the track, once per user per UTC day
  REPEAT_COMPLETION: 0.5, // a completion on another day
  EARLY_SKIP_PLAYLIST: -0.5, // skippedEarly in playlist mode
};

/** Vote half-life: a 7-day-old event weighs half of a fresh one. */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Wilson z — a 95 % lower bound. */
export const WILSON_Z = 1.96;

/** Chart entry threshold: fewer distinct voters → score 0, not chart-eligible. */
export const MIN_VOTERS = 10;

/**
 * Weight of one event: the signal's base weight scaled by the voter's
 * reputation and the exponential time decay (half-life parametrised).
 */
export function eventWeight(
  type: SignalType,
  userReputation: number,
  ageMs: number,
  halfLifeMs: number = HALF_LIFE_MS,
): number {
  const decay = Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);
  return SIGNAL_WEIGHTS[type] * userReputation * decay;
}

/**
 * Wilson lower bound for the binomial proportion with continuity
 * correction for small n: clamped to [0, 1]; 0 for N = 0.
 */
export function wilsonLowerBound(P: number, N: number, z: number = WILSON_Z): number {
  if (!Number.isFinite(P) || !Number.isFinite(N) || N <= 0) return 0;
  const p = Math.max(0, Math.min(1, P / N));
  const z2 = z * z;
  const centre = p + z2 / (2 * N);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * N)) / N);
  const lower = (centre - margin) / (1 + z2 / N);
  return Math.max(0, Math.min(1, lower));
}

/** One scored event after anti-fraud filtering (flagged events weigh 0). */
export interface RankedEvent {
  type: SignalType;
  /** The actor's reputation (0.2..1); anonymous listen events use 1. */
  reputation: number;
  /** Age of the event (ms) at scoring time. */
  ageMs: number;
  /** Distinct-user accounting (voters); anonymous events carry their hash. */
  actorId: string;
  /** Anti-fraud flag: the event carries weight 0 and is not a voter. */
  flagged?: boolean;
}

export type TrackScoreResult = {
  score: number;
  nEff: number;
  voters: number;
};

/**
 * Scores one track from its (already deduplicated) events:
 * P = Σ positive weights, N = P + Σ |negative| (weighted pseudo-counts),
 * score = Wilson lower bound, 0 below MIN_VOTERS distinct voters.
 * Deterministic: identical events give an identical result.
 */
export function scoreTrack(events: readonly RankedEvent[]): TrackScoreResult {
  let positives = 0;
  let negatives = 0;
  const voters = new Set<string>();
  for (const event of events) {
    if (event.flagged) continue; // anti-fraud: weight 0, not a voter either
    const weight = eventWeight(event.type, event.reputation, event.ageMs);
    if (weight >= 0) positives += weight;
    else negatives += -weight;
    if (event.type === "LIKE" || event.type === "DISLIKE") voters.add(event.actorId);
  }
  const nEff = positives + negatives;
  const score = voters.size >= MIN_VOTERS ? wilsonLowerBound(positives, nEff) : 0;
  return { score, nEff, voters: voters.size };
}

/**
 * Beta(alpha, beta) sampling for Thompson sampling, pure in the injected
 * rng. Uses gamma sampling (Marsaglia-Tsang) with a normal draw derived
 * from uniforms (Box-Muller), so any seeded uniform rng works.
 */
export function betaSample(alpha: number, beta: number, rng: () => number): number {
  const gamma = (shape: number): number => {
    if (shape < 1) {
      // Stuart's trick for the fractional case
      const u = Math.max(rng(), Number.EPSILON);
      return gamma(1 + shape) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const u1 = Math.max(rng(), Number.EPSILON);
      const u2 = rng();
      const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const v = Math.pow(1 + c * normal, 3);
      if (v <= 0) continue;
      const u3 = rng();
      if (Math.log(u3) < 0.5 * normal * normal + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const x = gamma(alpha) / (gamma(alpha) + gamma(beta));
  return Math.max(0, Math.min(1, x));
}
