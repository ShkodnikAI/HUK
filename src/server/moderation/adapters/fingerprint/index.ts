// Fingerprint adapter factory (H-205, task 3): the stage ships DISABLED
// unless ACOUSTID_API_KEY is set. With no key the pipeline gets the
// review-only adapter (SKIPPED), which the orchestrator treats as NOT
// PASSED — a missing key can therefore never yield an auto-approval.
// When a key IS configured, the Owner decision D5 (AcoustID
// non-commercial fit) must be recorded in issue #49 BEFORE the key lands
// in any shared environment (issue text, H-205).

import { loadEnv, type Env } from "@/server/env";
import type { SafeLoader } from "@/server/net/safe-fetch";
import type { FingerprintAdapter } from "../../types";
import { ReviewOnlyFingerprintAdapter } from "../fingerprint";
import { AcoustIdAdapter } from "./acoustid";

export type FingerprintEnv = Pick<Env, "ACOUSTID_API_KEY" | "FINGERPRINT_STRONG_SCORE">;

export function fingerprintAdapterFromEnv(
  env: FingerprintEnv = loadEnv(),
  opts?: { loader?: SafeLoader },
): FingerprintAdapter {
  if (!env.ACOUSTID_API_KEY) {
    return new ReviewOnlyFingerprintAdapter();
  }
  return new AcoustIdAdapter({
    apiKey: env.ACOUSTID_API_KEY,
    strongScore: env.FINGERPRINT_STRONG_SCORE,
    loader: opts?.loader,
  });
}

export { AcoustIdAdapter } from "./acoustid";
export { AuddAdapter, type AuddAdapterOptions } from "./audd";
export { createRateLimiter, acoustidRateLimiter, type RateLimiter } from "./rate";
export { cutSegments, AUDD_SEGMENT_SEC, type SegmentCut, type SegmentOpts } from "./segments";
