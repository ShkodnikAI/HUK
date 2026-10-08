// Moderation orchestrator (H-204, ARCHITECTURE §7): runs the cascade
//   0 declaration gate → 1 technical → 2 fingerprint → 3 ASR (vocals only)
//   → 4 policy verdict (LLM) → 5 human,
// writes one ModerationRun row per executed stage (cost + policyVersion),
// and applies the decision rules:
//   - REJECT only on a clear verdict above the threshold (or a technical
//     hard failure — duration/silence are objective, not model opinions);
//   - automatic APPROVE needs every earlier stage PASSED, no strong
//     fingerprint match and policy confidence >= DECISION_CONFIDENCE_THRESHOLD;
//   - everything else stays PENDING with a latest HUMAN/REVIEW run.
// Fail closed everywhere (S9): adapter error, timeout, unparsable output,
// BudgetExceeded — every anomaly maps to REVIEW, never to a pass.

import { HttpError } from "@/server/http/errors";
import { audit, sanitizePayload } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { withModerationFile } from "@/server/sources/verify";
import type { SafeLoader, SafeResolver } from "@/server/net/safe-fetch";
import { loadPolicy, type ModerationPolicy } from "./policy";
import { buildVerdictPrompt, type VerdictFields } from "./prompt";
import { parseVerdict, type ParsedVerdict } from "./verdict";
import { technicalCheck, type TechnicalResult } from "./technical";
import type {
  AsrResult,
  FingerprintResult,
  LlmResult,
  ModerationAdapters,
  StageName,
  StageVerdict,
} from "./types";
import { ReviewOnlyAsrAdapter } from "./adapters/asr";
import { ReviewOnlyLlmAdapter } from "./adapters/llm";
import { fingerprintAdapterFromEnv } from "./adapters/fingerprint/index";
import { loadEnv } from "@/server/env";

/** Confidence a policy verdict needs for an automatic APPROVE or REJECT. */
export const DECISION_CONFIDENCE_THRESHOLD = 0.75;

export type OrchestratorSeam = {
  client?: typeof defaultDb;
  adapters?: Partial<ModerationAdapters>;
  technical?: typeof technicalCheck;
  policy?: ModerationPolicy;
  maxBytes?: number;
  /** H-201 test seams (local fake hosts), passed through to the download. */
  loader?: SafeLoader;
  resolver?: SafeResolver;
  portAllowlist?: number[];
};

export type ModerationDecision = {
  decision: "APPROVED" | "REJECTED" | "REVIEW";
  reasons: string[];
  summary: string | null;
  confidence: number | null;
  policyVersion: string;
};

type StageRun = {
  stage: StageName;
  verdict: StageVerdict;
  confidence?: number;
  payload?: Record<string, unknown>;
  costMicroUsd: number;
};

/** Production adapter set; the fingerprint stage keys off env (H-205):
 *  ACOUSTID_API_KEY set → the real AcoustID adapter, otherwise review-only
 *  (SKIPPED ⇒ never auto-approve). ASR/LLM stay review-only until H-208. */
export function defaultAdapters(): ModerationAdapters {
  return {
    fingerprint: fingerprintAdapterFromEnv(loadEnv()),
    asr: new ReviewOnlyAsrAdapter(),
    llm: new ReviewOnlyLlmAdapter(),
  };
}

/**
 * Runs the full cascade for one track. Throws only for caller-level
 * conditions (unknown track); every moderation-level anomaly becomes a
 * typed decision instead (S9: review, never a silent pass).
 */
export async function moderateTrack(trackId: string, seam: OrchestratorSeam = {}): Promise<ModerationDecision> {
  const client = seam.client ?? defaultDb;
  const adapters: ModerationAdapters = { ...defaultAdapters(), ...seam.adapters };
  const technical = seam.technical ?? technicalCheck;
  const policy = seam.policy ?? loadPolicy();

  const track = await client.track.findUnique({ where: { id: trackId }, include: { source: true, artist: true } });
  if (!track) {
    throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${trackId}`);
  }

  const runs: StageRun[] = [];
  const record = (
    stage: StageName,
    verdict: StageVerdict,
    opts: { confidence?: number; payload?: Record<string, unknown>; costMicroUsd?: number } = {},
  ): void => {
    runs.push({
      stage,
      verdict,
      confidence: opts.confidence,
      payload: opts.payload,
      costMicroUsd: opts.costMicroUsd ?? 0,
    });
  };

  const reasons: string[] = [];
  let decisionSummary: string | null = null;
  let decisionConfidence: number | null = null;

  const persistRuns = async (): Promise<void> => {
    if (runs.length === 0) return;
    await client.moderationRun.createMany({
      data: runs.map((r) => ({
        trackId,
        stage: r.stage,
        verdict: r.verdict,
        confidence: r.confidence,
        payload: sanitizePayload(r.payload ?? {}),
        costMicroUsd: r.costMicroUsd,
        policyVersion: policy.version,
      })),
    });
  };

  const finish = async (decision: ModerationDecision["decision"]): Promise<ModerationDecision> => {
    await persistRuns();
    // The human-queue marker is a separate row written AFTER the stage rows,
    // so "latest run = HUMAN/REVIEW" is deterministic (task 4 of the naryad).
    if (decision === "REVIEW") {
      await client.moderationRun.create({
        data: {
          trackId,
          stage: "HUMAN",
          verdict: "REVIEW",
          payload: sanitizePayload({ note: "awaiting human review", reasons }),
          policyVersion: policy.version,
        },
      });
    }
    const now = new Date();
    const aiPatch = {
      aiConfidence: decisionConfidence,
      aiSummary: decisionSummary,
      moderatedBy: "ai",
      moderatedAt: now,
    };
    if (decision === "APPROVED") {
      await client.track.update({ where: { id: trackId }, data: { status: "APPROVED", ...aiPatch } });
      await audit({
        actorKind: "worker",
        action: "moderation.approved",
        targetType: "Track",
        targetId: trackId,
        payload: { confidence: decisionConfidence, policyVersion: policy.version },
      });
    } else if (decision === "REJECTED") {
      await client.track.update({ where: { id: trackId }, data: { status: "REJECTED", ...aiPatch } });
      await audit({
        actorKind: "worker",
        action: "moderation.rejected",
        targetType: "Track",
        targetId: trackId,
        payload: { reason: decisionSummary, confidence: decisionConfidence, policyVersion: policy.version },
      });
    } else {
      // Track stays PENDING; the HUMAN/REVIEW row (created above) marks it
      // for the human queue.
      await client.track.update({ where: { id: trackId }, data: { ...aiPatch } });
      await audit({
        actorKind: "worker",
        action: "moderation.review-queued",
        targetType: "Track",
        targetId: trackId,
        payload: { reasons, policyVersion: policy.version },
      });
    }
    return { decision, reasons, summary: decisionSummary, confidence: decisionConfidence, policyVersion: policy.version };
  };

  // ── 0. declaration gate ──────────────────────────────────────────────
  const missing: string[] = [];
  if (!track.rightsDeclaredAt) missing.push("rightsDeclaredAt");
  if (track.aiGenerated && !track.aiTool?.trim()) missing.push("aiTool");
  if (track.aiGenerated && !track.aiPlanAtCreation?.trim()) missing.push("aiPlanAtCreation");
  if (!track.humanContribution?.trim()) missing.push("humanContribution");
  if (missing.length > 0) {
    record("DECLARATION", "REVIEW", { payload: { note: "declaration gate: required declarations missing", missing } });
    reasons.push(`declaration gate: missing ${missing.join(", ")}`);
    return finish("REVIEW");
  }
  record("DECLARATION", "PASS", { payload: { note: "declarations complete" } });

  try {
    // ── 1-4 run inside the single transient download (S3: one fetch per
    // track, the temp file is deleted in withModerationFile's finally).
    const decision = await withModerationFile(
      track.id,
      async (file): Promise<ModerationDecision> => {
        // 1. technical — objective checks; a hard failure is a clear reject.
        let tech: TechnicalResult;
        try {
          tech = await technical(file.path);
        } catch (e) {
          tech = { ok: false, durationSec: 0, reason: `technical probe crashed: ${errMsg(e)}` };
        }
        record("TECHNICAL", tech.ok ? "PASS" : "REJECT", {
          payload: tech.ok
            ? { durationSec: tech.durationSec }
            : { reason: tech.reason, durationSec: tech.durationSec },
        });
        if (!tech.ok) {
          reasons.push(`technical: ${tech.reason}`);
          decisionSummary = tech.reason ?? "technical check failed";
          return finish("REJECTED");
        }

        // 2. fingerprint — SKIPPED (provider absent) blocks auto-approval.
        let fp: FingerprintResult;
        try {
          fp = await adapters.fingerprint.fingerprint(file);
        } catch (e) {
          fp = { verdict: "ERROR", strongMatch: false, bestScore: null, recording: null, costMicroUsd: 0, payload: { error: errMsg(e) } };
        }
        record("FINGERPRINT", fp.verdict, {
          payload: { strongMatch: fp.strongMatch, bestScore: fp.bestScore, recording: fp.recording, ...(fp.payload ?? {}) },
          costMicroUsd: fp.costMicroUsd,
        });
        let autoApprovable = true;
        if (fp.strongMatch) {
          autoApprovable = false;
          reasons.push("strong fingerprint match blocks auto-approval (policy item 7)");
        }
        if (fp.verdict !== "PASS") {
          autoApprovable = false;
          reasons.push(
            fp.verdict === "SKIPPED"
              ? "fingerprint stage skipped — not passed for auto-approval"
              : `fingerprint stage ${fp.verdict.toLowerCase()}`,
          );
        }

        // 3. ASR — only for tracks with vocals; a no-speech signal passes
        //    the stage as not-applicable.
        let transcript: string | null = null;
        if (track.instrumental) {
          record("ASR", "SKIPPED", { payload: { note: "instrumental — stage not applicable" } });
        } else {
          let asr: AsrResult;
          try {
            asr = await adapters.asr.transcribe(file);
          } catch (e) {
            asr = { verdict: "ERROR", transcript: null, language: null, noSpeech: false, costMicroUsd: 0, payload: { error: errMsg(e) } };
          }
          const asrPayload: Record<string, unknown> = { ...(asr.payload ?? {}) };
          if (asr.transcript) asrPayload.transcript = asr.transcript; // S7: the retention job expires this key
          if (asr.language) asrPayload.language = asr.language;
          const notApplicable = asr.verdict === "PASS" && asr.noSpeech;
          record("ASR", "PASS", {
            payload: notApplicable ? { note: "no speech detected — stage not applicable", ...asrPayload } : asrPayload,
            costMicroUsd: asr.costMicroUsd,
          });
          if (asr.verdict !== "PASS" && !notApplicable) {
            autoApprovable = false;
            reasons.push(
              asr.verdict === "SKIPPED"
                ? "ASR stage skipped — not passed for auto-approval"
                : `ASR stage ${asr.verdict.toLowerCase()}`,
            );
          }
          if (asr.verdict === "PASS" && !asr.noSpeech) transcript = asr.transcript;
        }

        // 4. policy verdict — parsed against the schema; every anomaly
        //    (timeout, error, unparsable, BudgetExceeded) lands in REVIEW.
        const fields: VerdictFields = {
          title: track.title,
          artist: track.artist?.displayName ?? null,
          transcript,
          links: readLinks(track.artist?.links),
          humanContribution: track.humanContribution,
        };
        const { prompt } = buildVerdictPrompt(policy, fields);
        let llm: LlmResult;
        try {
          llm = await adapters.llm.complete(prompt);
        } catch (e) {
          llm = { verdict: "ERROR", raw: null, costMicroUsd: 0, payload: { error: errMsg(e) } };
        }
        const parsed = parseVerdict(llm.raw);
        if (!parsed) {
          // The raw model output is NOT stored: it may echo untrusted text
          // under a key the retention job would never expire (S7).
          record("POLICY", "REVIEW", {
            payload: { note: "verdict missing or unparsable — fail closed to human review", adapterError: llm.payload?.error },
            costMicroUsd: llm.costMicroUsd,
          });
          autoApprovable = false;
          reasons.push("policy verdict unparsable or absent — REVIEW (S9)");
        } else {
          record("POLICY", parsed.verdict, {
            confidence: parsed.confidence,
            payload: { summary: parsed.summary, categories: parsed.categories },
            costMicroUsd: llm.costMicroUsd,
          });
          decisionSummary = parsed.summary;
          decisionConfidence = parsed.confidence;
          if (parsed.verdict === "REJECT" && parsed.confidence >= DECISION_CONFIDENCE_THRESHOLD) {
            reasons.push(`clear policy REJECT (confidence ${parsed.confidence})`);
            return finish("REJECTED");
          }
          if (parsed.verdict === "APPROVE" && parsed.confidence < DECISION_CONFIDENCE_THRESHOLD) {
            autoApprovable = false;
            reasons.push(`policy APPROVE below threshold (${parsed.confidence} < ${DECISION_CONFIDENCE_THRESHOLD})`);
          } else if (parsed.verdict !== "APPROVE") {
            autoApprovable = false;
          }
        }

        // 5. decision rules.
        if (autoApprovable && parsed && parsed.verdict === "APPROVE" && parsed.confidence >= DECISION_CONFIDENCE_THRESHOLD) {
          return finish("APPROVED");
        }
        if (parsed) reasons.push(`policy verdict: ${parsed.verdict} (confidence ${parsed.confidence})`);
        return finish("REVIEW");
      },
      { client, maxBytes: seam.maxBytes, loader: seam.loader, resolver: seam.resolver, portAllowlist: seam.portAllowlist },
    );
    return decision;
  } catch (e) {
    // Unexpected crash (download failure, DB hiccup): hold the track for a
    // human so the pass never retries the same track forever; fail loud.
    console.error(`[moderation] unexpected error for track ${trackId}:`, e);
    reasons.push(`unexpected error: ${errMsg(e)}`);
    return finish("REVIEW");
  }
}

// ───────────────────────── worker pass ─────────────────────────

export type PassSummary = {
  eligible: number;
  processed: number;
  approved: number;
  rejected: number;
  review: number;
  errors: number;
  /** Claimed by another worker instance while this pass was running (H-211). */
  skipped: number;
};

/**
 * Atomic per-track claim (H-211, G1 — defence in depth under the worker
 * leadership gate): one conditional UPDATE, so exactly one concurrent
 * instance wins. A track whose claim is stale (older than 10 minutes —
 * its worker crashed) becomes claimable again; the claim is released when
 * the pass finishes with the track.
 */
export async function claimModerationTrack(trackId: string, client: typeof defaultDb = defaultDb): Promise<boolean> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    UPDATE "Track" SET "moderationClaimedAt" = now()
    WHERE "id" = ${trackId} AND "status" = 'PENDING'
      AND ("moderationClaimedAt" IS NULL OR "moderationClaimedAt" < now() - interval '10 minutes')
    RETURNING "id"
  `;
  return rows.length === 1;
}

/** Releases the claim in `finally` (the pass is done with the track). */
export async function releaseModerationClaim(trackId: string, client: typeof defaultDb = defaultDb): Promise<void> {
  await client.$executeRaw`UPDATE "Track" SET "moderationClaimedAt" = NULL WHERE "id" = ${trackId}`;
}

/**
 * Consumes PENDING tracks whose latest run is not the HUMAN marker, with
 * bounded concurrency. Exhausted-budget and failed tracks stay PENDING —
 * the work is queued, never silently dropped (S6).
 */
export async function runModerationPass(
  opts: { limit?: number; concurrency?: number; seam?: OrchestratorSeam; log?: (line: string) => void } = {},
): Promise<PassSummary> {
  const client = opts.seam?.client ?? defaultDb;
  const log = opts.log ?? ((line: string) => console.log(line));
  const limit = opts.limit ?? 5;
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const candidates = await client.track.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: limit * 5,
    select: { id: true },
  });

  const eligible: string[] = [];
  for (const candidate of candidates) {
    if (eligible.length >= limit) break;
    const latest = await client.moderationRun.findFirst({
      where: { trackId: candidate.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { stage: true },
    });
    if (latest?.stage === "HUMAN") continue; // awaiting a human decision
    eligible.push(candidate.id);
  }

  const summary: PassSummary = {
    eligible: eligible.length,
    processed: 0,
    approved: 0,
    rejected: 0,
    review: 0,
    skipped: 0,
    errors: 0,
  };
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < eligible.length) {
      const trackId = eligible[cursor++];
      // H-211 (G1): the atomic claim makes duplicate paid work impossible
      // even if two passes race the same track; no row means another
      // instance owns it right now (or it left PENDING).
      if (!(await claimModerationTrack(trackId, client))) {
        summary.skipped++;
        continue;
      }
      try {
        const decision = await moderateTrack(trackId, opts.seam ?? {});
        summary.processed++;
        if (decision.decision === "APPROVED") summary.approved++;
        else if (decision.decision === "REJECTED") summary.rejected++;
        else summary.review++;
      } catch (e) {
        summary.errors++;
        log(`[moderation] track ${trackId} failed: ${errMsg(e)}`);
      } finally {
        await releaseModerationClaim(trackId, client);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, eligible.length) }, worker));

  if (summary.processed > 0) {
    await audit({
      actorKind: "worker",
      action: "moderation.pass",
      targetType: "System",
      targetId: "moderation",
      payload: { ...summary },
    });
  }
  return summary;
}

function readLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  return links
    .map((l) => (typeof l === "object" && l !== null && "url" in l ? String((l as { url: unknown }).url) : null))
    .filter((u): u is string => typeof u === "string" && u.length > 0)
    .slice(0, 10);
}

function errMsg(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
