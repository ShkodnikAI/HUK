// Moderation cascade contracts (H-204, ARCHITECTURE §7):
//   0 declaration gate → 1 technical → 2 fingerprint → 3 ASR (vocals only)
//   → 4 policy verdict (LLM) → 5 human.
// Adapters are the seam between the orchestrator and real providers (real
// fingerprint/ASR/LLM providers arrive with H-205/H-208; until then the
// shipped implementations are mock (tests) and review-only (fail closed)).

export type StageName = "DECLARATION" | "TECHNICAL" | "FINGERPRINT" | "ASR" | "POLICY" | "HUMAN";

export type StageVerdict = "PASS" | "APPROVE" | "REJECT" | "REVIEW" | "SKIPPED" | "ERROR";

/** The transient file downloaded for moderation (S3: deleted in finally). */
export type ModerationFileRef = {
  path: string;
  sha256: string;
  bytes: number;
};

export type StageOutcome = {
  verdict: StageVerdict;
  /** 0..1 when the stage has a notion of confidence. */
  confidence?: number;
  /** Evidence stored in ModerationRun.payload (transcripts expire, S7). */
  payload?: Record<string, unknown>;
  /** Cost observed through budget.guard (0 for free stages). */
  costMicroUsd: number;
};

// ───────────────────────── adapters ─────────────────────────

export type FingerprintResult = StageOutcome & {
  /** score >= FINGERPRINT_STRONG_SCORE (0.9 default, H-205). */
  strongMatch: boolean;
  bestScore: number | null;
  recording: string | null;
};

/**
 * Fingerprint stage adapter. A strong match blocks auto-approval (policy §7);
 * SKIPPED (no key / provider disabled) is treated as NOT PASSED by the
 * orchestrator: the track goes to human review, never silently through.
 */
export interface FingerprintAdapter {
  readonly provider: string;
  fingerprint(file: ModerationFileRef): Promise<FingerprintResult>;
}

export type AsrResult = StageOutcome & {
  /** Transcribed speech (may be stored transiently; retention job expires it). */
  transcript: string | null;
  language: string | null;
  /** True when the adapter signals speech-free audio; the stage is then N/A. */
  noSpeech: boolean;
};

/**
 * ASR stage adapter. Runs only for tracks with vocals (not instrumental).
 * A no-speech signal marks the stage passed-as-not-applicable; SKIPPED or
 * ERROR for a vocal track is NOT PASSED → human review.
 */
export interface AsrAdapter {
  readonly provider: string;
  transcribe(file: ModerationFileRef): Promise<AsrResult>;
}

export type LlmResult = StageOutcome & {
  /** Raw model output (for the parse layer); never echoed to users. */
  raw: string | null;
};

/**
 * Policy-verdict adapter (stage 4). The orchestrator parses and schema-checks
 * the output itself; the adapter only transports the prompt. Any parse or
 * schema failure, timeout, adapter error or BudgetExceeded → REVIEW (S9).
 */
export interface LlmAdapter {
  readonly provider: string;
  complete(prompt: string): Promise<LlmResult>;
}

/** The adapter set the orchestrator runs with (injectable for tests). */
export type ModerationAdapters = {
  fingerprint: FingerprintAdapter;
  asr: AsrAdapter;
  llm: LlmAdapter;
};
