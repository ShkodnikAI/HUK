// LLM adapters (H-204). The real policy-verdict provider arrives with H-208
// (provider choice is the Owner's decision D2/D5 family — issue #52);
// H-204 ships:
//   - MockLlmAdapter: deterministic test double; the default `echo` mode
//     returns the prompt itself, which the parse layer must fail closed on;
//   - ReviewOnlyLlmAdapter: the production default until H-208 — raw is
//     null, the parse layer fails closed, the stage ends in REVIEW.

import type { LlmAdapter, LlmResult } from "../types";

export type MockLlmConfig = {
  /** Fixed raw output; when omitted the adapter echoes its prompt. */
  raw?: string;
  payload?: Record<string, unknown>;
  costMicroUsd?: number;
  /** When set, the adapter throws instead of returning (timeout tests). */
  throw?: Error;
};

export class MockLlmAdapter implements LlmAdapter {
  readonly provider = "mock-llm";
  constructor(private readonly config: MockLlmConfig = {}) {}

  async complete(prompt: string): Promise<LlmResult> {
    if (this.config.throw) throw this.config.throw;
    return {
      verdict: "PASS", // transport-level: the raw output arrived (parse decides)
      raw: this.config.raw ?? prompt, // default: echo — an injection probe
      payload: this.config.payload,
      costMicroUsd: this.config.costMicroUsd ?? 0,
    };
  }
}

/** Production default until H-208 lands the real provider. */
export class ReviewOnlyLlmAdapter implements LlmAdapter {
  readonly provider = "review-only";
  async complete(_prompt: string): Promise<LlmResult> {
    return {
      verdict: "SKIPPED",
      raw: null,
      payload: { note: "LLM provider not configured (real adapter arrives with H-208, provider is an owner decision); stage fails closed to REVIEW" },
      costMicroUsd: 0,
    };
  }
}
