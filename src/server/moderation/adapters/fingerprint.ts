// Fingerprint adapters (H-204). The real AcoustID/AudD providers arrive with
// H-205; H-204 ships:
//   - MockFingerprintAdapter: deterministic test double (golden tests);
//   - ReviewOnlyFingerprintAdapter: the production default until H-205 —
//     returns SKIPPED, which the orchestrator treats as NOT PASSED, so no
//     track is ever auto-approved on an unchecked fingerprint (S9).

import type { FingerprintAdapter, FingerprintResult, ModerationFileRef } from "../types";

export type MockFingerprintConfig = {
  verdict: FingerprintResult["verdict"];
  strongMatch?: boolean;
  bestScore?: number | null;
  recording?: string | null;
  confidence?: number;
  payload?: Record<string, unknown>;
  costMicroUsd?: number;
  /** When set, the adapter throws instead of returning (timeout tests). */
  throw?: Error;
};

export class MockFingerprintAdapter implements FingerprintAdapter {
  readonly provider = "mock-fingerprint";
  constructor(private readonly config: MockFingerprintConfig) {}

  async fingerprint(_file: ModerationFileRef): Promise<FingerprintResult> {
    if (this.config.throw) throw this.config.throw;
    return {
      verdict: this.config.verdict,
      strongMatch: this.config.strongMatch ?? false,
      bestScore: this.config.bestScore ?? null,
      recording: this.config.recording ?? null,
      confidence: this.config.confidence,
      payload: this.config.payload,
      costMicroUsd: this.config.costMicroUsd ?? 0,
    };
  }
}

/** Production default until H-205 lands the real providers. */
export class ReviewOnlyFingerprintAdapter implements FingerprintAdapter {
  readonly provider = "review-only";
  async fingerprint(_file: ModerationFileRef): Promise<FingerprintResult> {
    return {
      verdict: "SKIPPED",
      strongMatch: false,
      bestScore: null,
      recording: null,
      payload: { note: "fingerprint provider not configured (real adapters arrive with H-205); SKIPPED blocks auto-approval" },
      costMicroUsd: 0,
    };
  }
}
