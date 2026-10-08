// AudD adapter (H-205, task 2) — ships DISABLED (AUDD_ENABLED=false, the
// owner decision on AudD's paid terms is pending) and fail closed:
//   - disabled (default) → SKIPPED, which the orchestrator treats as NOT
//     PASSED for auto-approval;
//   - enabled while the upload transport is absent → ERROR with the reason
//     (the pinned trusted transport is GET/HEAD only; sending 12 s segments
//     needs a bounded POST extension — proposed as a follow-up naryad, see
//     the PR report). The segment-sampling pipeline below is fully built
//     and tested so the transport can be dropped in without redesign.

import type { FingerprintAdapter, FingerprintResult, ModerationFileRef } from "../../types";
import { cutSegments, type ExecFileFn } from "./segments";

export type AuddAdapterOptions = {
  enabled: boolean;
  apiToken?: string;
  segments?: number;
  exec?: ExecFileFn;
  fileDurationSec?: (file: ModerationFileRef) => number;
};

export class AuddAdapter implements FingerprintAdapter {
  readonly provider = "audd";

  constructor(private readonly opts: AuddAdapterOptions) {}

  async fingerprint(file: ModerationFileRef): Promise<FingerprintResult> {
    if (!this.opts.enabled) {
      return {
        verdict: "SKIPPED",
        strongMatch: false,
        bestScore: null,
        recording: null,
        payload: { note: "AudD disabled (AUDD_ENABLED=false); owner decision on paid terms pending" },
        costMicroUsd: 0,
      };
    }

    // The pipeline is exercised up to the request boundary; the request
    // itself needs the POST-capable trusted transport (not in H-205 scope).
    let cut;
    try {
      const duration = this.opts.fileDurationSec?.(file) ?? 60;
      cut = await cutSegments(file.path, duration, { count: this.opts.segments ?? 4, exec: this.opts.exec });
      return {
        verdict: "ERROR",
        strongMatch: false,
        bestScore: null,
        recording: null,
        payload: {
          note: "AudD enabled but the upload transport is not available yet (trusted POST extension is a follow-up naryad); fail closed",
          segmentsSampled: cut.files.length,
        },
        costMicroUsd: 0,
      };
    } catch (e) {
      return {
        verdict: "ERROR",
        strongMatch: false,
        bestScore: null,
        recording: null,
        payload: { note: "audd segment sampling failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) },
        costMicroUsd: 0,
      };
    } finally {
      cut?.cleanup(); // S3: segments are transient, in every path
    }
  }
}
