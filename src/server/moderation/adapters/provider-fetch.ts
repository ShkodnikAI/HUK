// The ONLY outbound door for moderation provider adapters (H-204, S4+S6):
// every provider request a real adapter will ever make goes through
// guardedProviderFetch, which wraps trustedFetch in budget.guard — a request
// cannot leave this module without a reservation against BudgetLedger.
//
// Honest cost accounting (H-213, G5): a failure that happens BEFORE the
// request could be billed is translated to NotChargedError (DNS failure,
// connect failure, the URL/host/port validation) so budget.guard refunds
// the reservation. A 4xx answered before any processing was not billable
// either: the response object is still handed to the adapter (it may carry
// rate-limit semantics), but the call settles to 0. Every other failure
// (timeout after send, truncated body, redirects gone wrong) is ambiguous —
// it propagates as-is and the guard keeps the reservation (conservative).
//
// CI: scripts/ci/check-provider-guard.mjs forbids the literal `trustedFetch`
// anywhere under src/server/moderation/adapters/** except this file, so a
// future adapter cannot bypass the fuse.

import { guard, NotChargedError } from "@/server/budget";
import { trustedFetch, type TrustedFetchOptions } from "@/server/net/trusted-fetch";
import { SafeFetchError, type SafeFetchErrorCode, type SafeFetchResult } from "@/server/net/safe-fetch";

export type GuardedFetchOptions = TrustedFetchOptions & {
  /** Ledger provider key ("acoustid", "audd", "asr", "llm", ...). */
  provider: string;
  /** Reservation and settle value: per-request providers bill a fixed price. */
  estimateMicroUsd: number;
  /** Optional per-provider daily cap override (S6). */
  capMicroUsd?: number;
};

/**
 * Failures that happen before any request could reach the provider (or
 * before a connection existed): the reservation is provably unspent.
 * A total TIMEOUT after send, BODY_TOO_LARGE and redirect failures are
 * deliberately NOT here — the request may already have been billed.
 */
const NOT_CHARGED_CODES: ReadonlySet<SafeFetchErrorCode> = new Set([
  "INVALID_URL",
  "INSECURE_TRANSPORT",
  "USERINFO_FORBIDDEN",
  "PORT_FORBIDDEN",
  "HOST_FORBIDDEN",
  "DNS_FAILED",
  "PRIVATE_ADDRESS",
  "CONNECT_TIMEOUT",
  "BAD_RESPONSE", // trusted-fetch: unreachable after retries (connect-level)
]);

/**
 * One paid provider request: reserve estimate → fetch → settle. Pre-billing
 * failures throw NotChargedError (the guard refunds); a 4xx settles to 0
 * and still returns the response; everything else propagates as-is and
 * keeps the reservation (conservative, G5).
 */
export async function guardedProviderFetch(
  url: string,
  opts: GuardedFetchOptions,
): Promise<SafeFetchResult> {
  return guard(
    { provider: opts.provider, estimateMicroUsd: opts.estimateMicroUsd, capMicroUsd: opts.capMicroUsd },
    async () => {
      let res: SafeFetchResult;
      try {
        res = await trustedFetch(url, {
          method: opts.method,
          maxBytes: opts.maxBytes,
          connectTimeoutMs: opts.connectTimeoutMs,
          totalTimeoutMs: opts.totalTimeoutMs,
          retries: opts.retries,
          backoffMs: opts.backoffMs,
          loader: opts.loader,
        });
      } catch (e) {
        if (e instanceof SafeFetchError && NOT_CHARGED_CODES.has(e.code)) {
          throw new NotChargedError(opts.provider, `${e.code}: ${e.message}`);
        }
        throw e;
      }
      // A 4xx answered before any processing was not billed: hand the
      // response to the adapter (it may inspect the status) and settle 0.
      return { result: res, costMicroUsd: res.status >= 400 ? 0 : opts.estimateMicroUsd };
    },
  );
}
