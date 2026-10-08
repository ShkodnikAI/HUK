// AcoustID fingerprint adapter (H-205): computes the Chromaprint
// fingerprint with `fpcalc` (libchromaprint-tools, worker image only) and
// looks it up on api.acoustid.org through guardedProviderFetch — the
// budget.guard'd trusted door (S6/S4) — under the process-wide 3 rps
// ceiling. The response maps to the stage contract: strongMatch at
// score >= FINGERPRINT_STRONG_SCORE (0.9 default), bestScore and the
// matched recording for ModerationRun.payload.
//
// Fail closed: provider errors, rate-limit responses and unmappable
// payloads all become ERROR (never a pass); the factory ships the adapter
// only when ACOUSTID_API_KEY is set (missing key → SKIPPED upstream).

import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { guardedProviderFetch } from "../provider-fetch";
import type { ModerationFileRef, FingerprintAdapter, FingerprintResult } from "../../types";
import type { SafeFetchResult } from "@/server/net/safe-fetch";
import { acoustidRateLimiter, type RateLimiter } from "./rate";

const ACOUSTID_LOOKUP_URL = "https://api.acoustid.org/v2/lookup";
/** fpcalc reads at most this many seconds of audio for the fingerprint. */
const FPCALC_MAX_LENGTH_SEC = 120;
/** Lookup cap: the response is small JSON; 1 MiB is generous. */
const LOOKUP_MAX_BYTES = 1024 * 1024;

export type AcoustIdAdapterOptions = {
  apiKey: string;
  /** Strong-match threshold (env FINGERPRINT_STRONG_SCORE, default 0.9). */
  strongScore?: number;
  /** Recorded-response seam for tests (production: the guarded door). */
  fetch?: (url: string) => Promise<SafeFetchResult>;
  /** Passed through to the guarded door in production. */
  loader?: import("@/server/net/safe-fetch").SafeLoader;
  limiter?: RateLimiter;
  /** fpcalc seam for tests (default: real exec with a hard timeout). */
  fpcalc?: (file: string) => Promise<{ fingerprint: string; durationSec: number }>;
};

export type AcoustIdLookup = {
  status: string;
  error?: { code?: number; message?: string };
  results?: Array<{
    id?: string;
    score?: number;
    recordings?: Array<{ id?: string; title?: string; artists?: Array<{ name?: string }> }>;
  }>;
};

const defaultFpcalc = async (file: string): Promise<{ fingerprint: string; durationSec: number }> => {
  const run = promisify(execFile);
  const { stdout } = await run(
    "fpcalc",
    ["-json", "-length", String(FPCALC_MAX_LENGTH_SEC), file],
    { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { duration?: number; fingerprint?: string };
  if (!parsed.fingerprint) {
    throw new Error("fpcalc produced no fingerprint");
  }
  return { fingerprint: parsed.fingerprint, durationSec: Number(parsed.duration ?? 0) };
};

export class AcoustIdAdapter implements FingerprintAdapter {
  readonly provider = "acoustid";
  private readonly strongScore: number;

  constructor(private readonly opts: AcoustIdAdapterOptions) {
    this.strongScore = opts.strongScore ?? 0.9;
  }

  async fingerprint(file: ModerationFileRef): Promise<FingerprintResult> {
    let fingerprint: string;
    let durationSec: number;
    try {
      const calc = this.opts.fpcalc ?? defaultFpcalc;
      const calcResult = await calc(file.path);
      fingerprint = calcResult.fingerprint;
      durationSec = calcResult.durationSec;
    } catch (e) {
      return {
        verdict: "ERROR",
        strongMatch: false,
        bestScore: null,
        recording: null,
        payload: { note: "fpcalc failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) },
        costMicroUsd: 0,
      };
    }

    // The 3 rps ceiling is a client-term obligation: wait for the slot
    // BEFORE spending the budget reservation.
    const limiter = this.opts.limiter ?? acoustidRateLimiter;
    await limiter.acquire();

    try {
      const url = `${ACOUSTID_LOOKUP_URL}?client=${encodeURIComponent(this.opts.apiKey)}&fingerprint=${encodeURIComponent(fingerprint)}&duration=${Math.round(durationSec) || FPCALC_MAX_LENGTH_SEC}&meta=recordings`;
      // Production: budget.guard + the trusted allowlist transport (S4/S6).
      // Tests: the recorded-response fetch seam (no network anywhere).
      const res = this.opts.fetch
        ? await this.opts.fetch(url)
        : await guardedProviderFetch(url, {
            provider: "acoustid",
            estimateMicroUsd: 0, // AcoustID is free for non-commercial use (D5 record still owed before any shared-env key)
            maxBytes: LOOKUP_MAX_BYTES,
            totalTimeoutMs: 15_000,
            retries: 0, // the limiter already spaces attempts; a 429 surfaces below
            loader: this.opts.loader,
          });

      if (res.status === 429) {
        return { verdict: "ERROR", strongMatch: false, bestScore: null, recording: null, payload: { note: "acoustid rate limited (429)" }, costMicroUsd: 0 };
      }
      if (res.status !== 200) {
        return { verdict: "ERROR", strongMatch: false, bestScore: null, recording: null, payload: { note: `acoustid answered ${res.status}` }, costMicroUsd: 0 };
      }

      const body = JSON.parse(new TextDecoder().decode(res.body ?? new Uint8Array())) as AcoustIdLookup;
      if (body.status !== "ok") {
        return {
          verdict: "ERROR",
          strongMatch: false,
          bestScore: null,
          recording: null,
          payload: { note: "acoustid lookup failed", error: body.error?.message ?? `status ${body.status}` },
          costMicroUsd: 0,
        };
      }

      const best = body.results?.[0];
      const bestScore = typeof best?.score === "number" ? best.score : null;
      const recording = best?.recordings?.[0];
      const recordingLabel =
        recording === undefined
          ? null
          : {
              id: recording.id ?? null,
              title: recording.title ?? null,
              artist: recording.artists?.map((a) => a.name).filter(Boolean).join(", ") || null,
            };
      return {
        verdict: "PASS",
        strongMatch: bestScore !== null && bestScore >= this.strongScore,
        bestScore,
        recording: recordingLabel?.id ?? null,
        payload: { provider: this.provider, bestScore, recording: recordingLabel },
        costMicroUsd: 0,
      };
    } catch (e) {
      return {
        verdict: "ERROR",
        strongMatch: false,
        bestScore: null,
        recording: null,
        payload: { note: "acoustid lookup error", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) },
        costMicroUsd: 0,
      };
    }
  }
}
