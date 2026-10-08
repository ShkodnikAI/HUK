// S6 cost fuse (H-204): every paid API call goes through budget.guard().
// The guard RESERVES the estimated cost against BudgetLedger atomically
// (advisory lock serialises reservations for the day, so concurrent calls
// can never overshoot the cap between check and write), runs the call, then
// SETTLES the actual cost (adjusting the reservation by the difference).
// Exceeding the daily total (BUDGET_DAILY_MICRO_USD_TOTAL, from env) or an
// optional per-provider cap throws BudgetExceeded — the stage stops and the
// work stays queued; it never silently continues (S6/S9).
//
// The ledger is the only accounting surface: `day` is UTC midnight, one row
// per (day, provider), `costMicroUsd` is the running reserved+settled total,
// `calls` counts guard invocations. A failed call releases its reservation
// ONLY when the adapter certifies the request could not be billed
// (NotChargedError: DNS/connect failure, local validation, 4xx before
// processing); every other failure keeps the reservation — conservative,
// because the provider may already have charged — and the call is recorded
// as `uncertain` in the log and the audit trail (H-213, G5).

import { loadEnv, type Env } from "@/server/env";
import { db as defaultDb } from "@/server/db";
import { audit } from "@/server/audit";

/** Thrown when a reservation would push the day (or provider) over its cap. */
export class BudgetExceeded extends Error {
  readonly provider: string;
  readonly attemptedMicroUsd: number;

  constructor(provider: string, attemptedMicroUsd: number, detail: string) {
    super(`BudgetExceeded (${provider}): ${detail}`);
    this.name = "BudgetExceeded";
    this.provider = provider;
    this.attemptedMicroUsd = attemptedMicroUsd;
  }
}

/**
 * Thrown by provider adapters ONLY for failures that happen before a
 * request could be billed: a DNS/connect failure, local validation, or a
 * 4xx answered before any processing. `guard` refunds the reservation for
 * this error and nothing else (H-213, G5).
 */
export class NotChargedError extends Error {
  readonly provider: string;

  constructor(provider: string, detail: string) {
    super(`NotChargedError (${provider}): ${detail}`);
    this.name = "NotChargedError";
    this.provider = provider;
  }
}

export type GuardSeam = {
  client?: typeof defaultDb;
  env?: Pick<Env, "BUDGET_DAILY_MICRO_USD_TOTAL">;
  now?: () => Date;
};

export type GuardOptions = {
  /** Ledger provider key (e.g. "asr", "llm", "acoustid"). */
  provider: string;
  /** Reservation made BEFORE the call runs; settled to the actual afterwards. */
  estimateMicroUsd: number;
  /**
   * Optional per-provider daily cap (micro USD). Defaults to the code-level
   * PROVIDER_DAILY_CAPS table; env wiring is a later naryad (env.ts is not in
   * H-204 scope).
   */
  capMicroUsd?: number;
};

export type GuardResult<T> = {
  result: T;
  /** Actual cost the caller observed; settled against the reservation. */
  costMicroUsd: number;
};

/**
 * Code-level default per-provider daily caps (micro USD), extendable by
 * callers via `capMicroUsd`. Empty by default: the daily total is the cap
 * until a naryad sets provider budgets.
 */
export const PROVIDER_DAILY_CAPS: Readonly<Record<string, number>> = {};

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Runs `fn` under the cost fuse. The reservation is written and checked in
 * one transaction (pg advisory xact lock on the day → no two concurrent
 * guards can both pass a cap that only one fits); `fn` then runs outside the
 * transaction and returns the actual cost; a second transaction settles the
 * difference. If `fn` throws NotChargedError the reservation is refunded;
 * any other failure keeps it and the call is logged as `uncertain` (G5).
 */
export async function guard<T>(
  opts: GuardOptions,
  fn: () => Promise<GuardResult<T>>,
  seam: GuardSeam = {},
): Promise<T> {
  if (!Number.isFinite(opts.estimateMicroUsd) || opts.estimateMicroUsd < 0) {
    throw new Error(`budget.guard: invalid estimateMicroUsd ${opts.estimateMicroUsd}`);
  }
  const client = seam.client ?? defaultDb;
  const env = seam.env ?? loadEnv();
  const now = seam.now ?? (() => new Date());
  const day = utcMidnight(now());
  const cap = opts.capMicroUsd ?? PROVIDER_DAILY_CAPS[opts.provider];

  // 1. Reserve atomically: serialise on the day, upsert the provider row,
  //    and refuse when the daily total or the provider cap would overflow.
  await client.$transaction(async (tx) => {
    // One lock for the whole day keeps the cross-provider total exact.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"budget:" + day.toISOString().slice(0, 10)}))`;
    await tx.budgetLedger.upsert({
      where: { day_provider: { day, provider: opts.provider } },
      create: { day, provider: opts.provider, costMicroUsd: BigInt(Math.round(opts.estimateMicroUsd)), calls: 1 },
      update: { costMicroUsd: { increment: BigInt(Math.round(opts.estimateMicroUsd)) }, calls: { increment: 1 } },
    });
    const rows = await tx.budgetLedger.groupBy({
      by: ["provider"],
      where: { day },
      _sum: { costMicroUsd: true },
    });
    const total = rows.reduce((acc, r) => acc + (r._sum.costMicroUsd ?? 0n), 0n);
    if (total > BigInt(env.BUDGET_DAILY_MICRO_USD_TOTAL)) {
      throw new BudgetExceeded(
        opts.provider,
        opts.estimateMicroUsd,
        `daily total ${total} micro USD would exceed BUDGET_DAILY_MICRO_USD_TOTAL=${env.BUDGET_DAILY_MICRO_USD_TOTAL}`,
      );
    }
    if (cap !== undefined) {
      const providerRow = rows.find((r) => r.provider === opts.provider);
      const providerTotal = providerRow?._sum.costMicroUsd ?? 0n;
      if (providerTotal > BigInt(cap)) {
        throw new BudgetExceeded(opts.provider, opts.estimateMicroUsd, `provider cap ${cap} exceeded (spent ${providerTotal})`);
      }
    }
  });

  // 2. Run the paid call outside the transaction.
  try {
    const { result, costMicroUsd } = await fn();
    // 3. Settle the actual cost (may adjust up or down; only when the
    //    observed cost is known — a caller returning a negative value is a
    //    contract bug and fails loud).
    if (!Number.isFinite(costMicroUsd) || costMicroUsd < 0) {
      throw new Error(`budget.guard: fn returned invalid costMicroUsd ${costMicroUsd}`);
    }
    const delta = BigInt(Math.round(costMicroUsd)) - BigInt(Math.round(opts.estimateMicroUsd));
    if (delta !== 0n) {
      await client.budgetLedger.update({
        where: { day_provider: { day, provider: opts.provider } },
        data: { costMicroUsd: { increment: delta } },
      });
    }
    return result;
  } catch (e) {
    if (e instanceof NotChargedError) {
      // The adapter certifies the request could not be billed: refund the
      // reservation (H-213, G5).
      await client.budgetLedger.update({
        where: { day_provider: { day, provider: opts.provider } },
        data: { costMicroUsd: { decrement: BigInt(Math.round(opts.estimateMicroUsd)) } },
      }).catch(() => {
        /* the ledger row must exist (created above); nothing else to do */
      });
      throw e;
    }
    // Conservative (H-213, G5): any other failure — a timeout after send, a
    // truncated body, an unknown error — keeps the reservation, because the
    // provider may already have charged. The call is recorded as `uncertain`
    // (loud log + best-effort audit row; the ledger has no payload column).
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[budget] UNCERTAIN charge for ${opts.provider}: reservation ${opts.estimateMicroUsd} micro USD kept — ${detail.slice(0, 200)}`);
    await audit({
      actorKind: "worker",
      action: "budget.uncertain",
      targetType: "BudgetLedger",
      targetId: opts.provider,
      payload: { provider: opts.provider, estimateMicroUsd: opts.estimateMicroUsd, day: day.toISOString().slice(0, 10), error: detail.slice(0, 300) },
    }).catch(() => {
      /* best-effort: the reservation itself already covers the risk */
    });
    throw e;
  }
}
