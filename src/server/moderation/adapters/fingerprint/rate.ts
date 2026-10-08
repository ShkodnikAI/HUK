// Process-wide client-side rate limiter for fingerprint lookups (H-205):
// AcoustID allows at most 3 requests/second per client key, shared across
// the whole process. The limiter is a strictly sequential scheduler: every
// acquire() gets the next slot at least `intervalMs` after the previous
// one. `now`/`sleep` are injectable so tests can prove the ceiling without
// real waiting (50 concurrent acquires in microseconds).

export type RateLimiterOptions = {
  /** Requests per second ceiling (positive). */
  perSecond: number;
  /** Injectable clock (Date.now by default). */
  now?: () => number;
  /** Injectable waiter (real setTimeout by default). */
  sleep?: (ms: number) => Promise<void>;
};

export type RateLimiter = {
  /** Resolves when the caller may fire its request. */
  acquire: () => Promise<void>;
};

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  if (!Number.isFinite(opts.perSecond) || opts.perSecond <= 0) {
    throw new Error(`rate limiter: invalid perSecond ${opts.perSecond}`);
  }
  const intervalMs = 1000 / opts.perSecond;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastSlot = -Infinity;
  let chain: Promise<void> = Promise.resolve();

  return {
    acquire(): Promise<void> {
      // Serialise through a promise chain: slots are handed out in order,
      // each at least intervalMs after the previous one, and the first
      // caller goes through immediately.
      const next = chain.then(async () => {
        const t = now();
        const earliest = Number.isFinite(lastSlot) ? lastSlot + intervalMs : t;
        const slot = Math.max(t, earliest);
        if (slot > t) await sleep(slot - t);
        lastSlot = slot;
      });
      // The queue must survive a failed waiter (none today, but fail open
      // of the QUEUE is not an option: keep the chain alive regardless).
      chain = next.catch(() => {});
      return next;
    },
  };
}

/** The process-wide AcoustID limiter (3 rps, AcoustID client-term ceiling). */
export const acoustidRateLimiter: RateLimiter = createRateLimiter({ perSecond: 3 });
