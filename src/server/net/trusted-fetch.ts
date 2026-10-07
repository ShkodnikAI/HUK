// S4 (H-201) — the second door: fetches to a FIXED allowlist of provider
// hostnames (configured here, in code). https only, port 443, timeouts,
// bounded retries for idempotent GET, and redirects are rejected when they
// leave the trusted host. Everything underneath is safeFetch's validated,
// pinned transport.

import { safeFetch, SafeFetchError, type SafeFetchResult, type SafeLoader } from "./safe-fetch";

/**
 * The fixed provider host allowlist (AGENTS §5 S4: Audius, ASR, LLM; plus
 * the fingerprint providers arriving with H-205). New providers are added
 * HERE by a naryad — never via configuration, never dynamically.
 */
export const TRUSTED_HOSTS: ReadonlySet<string> = new Set([
  "api.audius.co", // Audius discovery/API (H-202)
  "discoveryprovider.audius.co", // Audius discovery provider endpoint
  "api.acoustid.org", // AcoustID lookup (H-205)
  "api.audd.io", // AudD (H-205, optional provider)
]);

export type TrustedFetchOptions = {
  method?: "GET" | "HEAD";
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** Bounded retries for idempotent GET (default 2; never for HEAD). */
  retries?: number;
  /** Backoff base in ms (default 250, exponential x2). */
  backoffMs?: number;
  /** H-201 test seam (recorded fixtures); production uses the pinned transport. */
  loader?: SafeLoader;
};

const RETRYABLE_CODES = new Set(["CONNECT_TIMEOUT", "TIMEOUT", "DNS_FAILED", "BAD_RESPONSE"]);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch from a fixed, code-configured provider host. Fail closed with a
 * typed SafeFetchError for anything outside the allowlist (S9).
 */
export async function trustedFetch(
  rawUrl: string,
  opts: TrustedFetchOptions = {},
): Promise<SafeFetchResult> {
  const method = opts.method ?? "GET";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("INVALID_URL", "not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new SafeFetchError("INSECURE_TRANSPORT", "trusted providers are https only");
  }
  if (!TRUSTED_HOSTS.has(url.hostname.toLowerCase())) {
    throw new SafeFetchError("HOST_FORBIDDEN", `${url.hostname} is not in the trusted provider allowlist`);
  }

  const retries = method === "GET" ? (opts.retries ?? 2) : 0;
  const backoffMs = opts.backoffMs ?? 250;

  let lastError: SafeFetchError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
    try {
      const res = await safeFetch(rawUrl, {
        method,
        maxBytes: opts.maxBytes,
        connectTimeoutMs: opts.connectTimeoutMs,
        totalTimeoutMs: opts.totalTimeoutMs,
        maxHops: 3,
        sameHostOnly: true, // a provider redirect may not leave the allowlist
        loader: opts.loader,
      });
      if (RETRYABLE_STATUSES.has(res.status) && attempt < retries) {
        lastError = new SafeFetchError("BAD_RESPONSE", `provider answered ${res.status}`);
        continue;
      }
      return res;
    } catch (e) {
      if (e instanceof SafeFetchError && RETRYABLE_CODES.has(e.code) && attempt < retries) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new SafeFetchError("BAD_RESPONSE", "unreachable");
}
