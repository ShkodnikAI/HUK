// ASR adapters (H-204). The real transcription provider arrives with H-208;
// H-204 ships:
//   - MockAsrAdapter: deterministic test double (golden tests);
//   - ReviewOnlyAsrAdapter: the production default until H-208 — returns
//     SKIPPED for vocal tracks, which the orchestrator treats as NOT PASSED,
//     so no track with untranscribed speech is auto-approved (S9).

import type { AsrAdapter, AsrResult, ModerationFileRef } from "../types";

export type MockAsrConfig = {
  verdict: AsrResult["verdict"];
  transcript?: string | null;
  language?: string | null;
  noSpeech?: boolean;
  payload?: Record<string, unknown>;
  costMicroUsd?: number;
  /** When set, the adapter throws instead of returning (timeout tests). */
  throw?: Error;
};

export class MockAsrAdapter implements AsrAdapter {
  readonly provider = "mock-asr";
  constructor(private readonly config: MockAsrConfig) {}

  async transcribe(_file: ModerationFileRef): Promise<AsrResult> {
    if (this.config.throw) throw this.config.throw;
    return {
      verdict: this.config.verdict,
      transcript: this.config.transcript ?? null,
      language: this.config.language ?? null,
      noSpeech: this.config.noSpeech ?? false,
      payload: this.config.payload,
      costMicroUsd: this.config.costMicroUsd ?? 0,
    };
  }
}

/** Production default until H-208 lands the real provider. */
export class ReviewOnlyAsrAdapter implements AsrAdapter {
  readonly provider = "review-only";
  async transcribe(_file: ModerationFileRef): Promise<AsrResult> {
    return {
      verdict: "SKIPPED",
      transcript: null,
      language: null,
      noSpeech: false,
      payload: { note: "ASR provider not configured (real adapter arrives with H-208); SKIPPED blocks auto-approval for vocal tracks" },
      costMicroUsd: 0,
    };
  }
}
