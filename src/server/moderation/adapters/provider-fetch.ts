// The ONLY outbound door for moderation provider adapters (H-204, S4+S6):
// every provider request a real adapter will ever make goes through
// guardedProviderFetch, which wraps trustedFetch in budget.guard — a request
// cannot leave this module without a reservation against BudgetLedger.
//
// CI: scripts/ci/check-provider-guard.mjs forbids the literal `trustedFetch`
// anywhere under src/server/moderation/adapters/** except this file, so a
// future adapter cannot bypass the fuse. (H-204 ships no real provider calls
// yet — the module exists so the guard is the path of least resistance for
// H-205/H-208, and the tripwire is red-testable today.)

import { guard } from "@/server/budget";
import { trustedFetch, type TrustedFetchOptions } from "@/server/net/trusted-fetch";
import type { SafeFetchResult } from "@/server/net/safe-fetch";

export type GuardedFetchOptions = TrustedFetchOptions & {
  /** Ledger provider key ("acoustid", "audd", "asr", "llm", ...). */
  provider: string;
  /** Reservation and settle value: per-request providers bill a fixed price. */
  estimateMicroUsd: number;
  /** Optional per-provider daily cap override (S6). */
  capMicroUsd?: number;
};

/**
 * One paid provider request: reserve estimate → fetch → settle the same
 * value (per-request pricing). Transport errors release the reservation
 * (guard settles to 0 when fn throws) and propagate as typed SafeFetchError.
 */
export async function guardedProviderFetch(
  url: string,
  opts: GuardedFetchOptions,
): Promise<SafeFetchResult> {
  return guard(
    { provider: opts.provider, estimateMicroUsd: opts.estimateMicroUsd, capMicroUsd: opts.capMicroUsd },
    async () => {
      const res = await trustedFetch(url, {
        method: opts.method,
        maxBytes: opts.maxBytes,
        connectTimeoutMs: opts.connectTimeoutMs,
        totalTimeoutMs: opts.totalTimeoutMs,
        retries: opts.retries,
        backoffMs: opts.backoffMs,
        loader: opts.loader,
      });
      return { result: res, costMicroUsd: opts.estimateMicroUsd };
    },
  );
}
