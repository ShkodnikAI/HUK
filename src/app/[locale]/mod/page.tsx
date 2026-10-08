// Moderator console (H-207): /[locale]/mod, MODERATOR/ADMIN only.
// Order is the contract: the role gate runs FIRST (server-side, requireRole
// through the real request headers) — anonymous gets a redirect, listeners
// and artists get the forbidden screen, and NO query has run at that point.
// Only after the gate do the queues load (moderation queue: PENDING tracks
// whose latest run is the HUMAN/REVIEW marker; reports queue: OPEN reports).
// Actions live in the client components and go through the existing APIs;
// every action the APIs perform writes an AuditLog row with the actor.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requireRole } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { db } from "@/server/db";
import { listOpenReports } from "@/server/reports/service";
import { TrackActions } from "@/components/mod/track-actions";
import { ReportActions } from "@/components/mod/report-actions";
import { TranscriptExcerpt } from "@/components/mod/transcript-excerpt";

export const dynamic = "force-dynamic";

type PrismaLike = typeof db;

/** Rebuilds the request for the guard from the real server headers. */
async function gateRequest(): Promise<Request> {
  const h = await headers();
  return new Request("http://localhost/mod", { headers: h });
}

export type ModerationQueueItem = {
  trackId: string;
  title: string;
  durationSec: number;
  instrumental: boolean;
  language: string | null;
  aiGenerated: boolean;
  aiTool: string | null;
  humanContribution: string | null;
  aiSummary: string | null;
  aiConfidence: number | null;
  transcript: string | null;
  fingerprint: { strongMatch?: boolean; bestScore?: number | null; recording?: string | null } | null;
  costMicroUsd: number;
  policyVersion: string | null;
  audits: Array<{ id: string; action: string; actorId: string | null; createdAt: Date }>;
};

/**
 * PENDING tracks whose latest ModerationRun is the HUMAN/REVIEW marker,
 * with the evidence the moderator needs: declarations, AI summary and
 * confidence, transcript excerpt, fingerprint match, cost, policy version
 * and the audit trail. Exported for the DB contract tests.
 */
export async function loadModerationQueue(client: PrismaLike = db, take = 50): Promise<ModerationQueueItem[]> {
  const candidates = await client.track.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: take * 3,
    include: { artist: true },
  });

  const items: ModerationQueueItem[] = [];
  for (const track of candidates) {
    if (items.length >= take) break;
    const runs = await client.moderationRun.findMany({
      where: { trackId: track.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const latest = runs.at(-1);
    if (!latest || latest.stage !== "HUMAN") continue; // only human-queued tracks

    const asrRun = [...runs].reverse().find((r) => r.stage === "ASR");
    const fpRun = [...runs].reverse().find((r) => r.stage === "FINGERPRINT");
    const asrPayload = (asrRun?.payload ?? {}) as { transcript?: unknown };
    const fpPayload = (fpRun?.payload ?? {}) as {
      strongMatch?: boolean;
      bestScore?: number | null;
      recording?: { id?: string | null; title?: string | null } | null;
    };
    const audits = await client.auditLog.findMany({
      where: { targetType: "Track", targetId: track.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, action: true, actorId: true, createdAt: true },
    });

    items.push({
      trackId: track.id,
      title: track.title,
      durationSec: track.durationSec,
      instrumental: track.instrumental,
      language: track.language,
      aiGenerated: track.aiGenerated,
      aiTool: track.aiTool,
      humanContribution: track.humanContribution,
      aiSummary: track.aiSummary,
      aiConfidence: track.aiConfidence,
      transcript: typeof asrPayload.transcript === "string" ? asrPayload.transcript : null,
      fingerprint: fpRun
        ? {
            strongMatch: fpPayload.strongMatch ?? false,
            bestScore: fpPayload.bestScore ?? null,
            recording: fpPayload.recording?.id ?? null,
          }
        : null,
      costMicroUsd: Number(runs.reduce((acc, r) => acc + Number(r.costMicroUsd), 0)),
      policyVersion: latest.policyVersion ?? null,
      audits,
    });
  }
  return items;
}

export default async function ModConsolePage() {
  const t = await getTranslations("mod");

  // ── 1. the gate: role check BEFORE any data is read (S1, H-207) ──
  let actorId: string | null = null;
  try {
    const { user } = await requireRole(await gateRequest(), "MODERATOR");
    actorId = user.id;
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      redirect("/"); // anonymous: away from the console entirely
    }
    void actorId;
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <h1 className="text-xl font-semibold text-[#D4AF37]">{t("title")}</h1>
        <p className="mt-4 text-sm text-neutral-300">{t("forbidden")}</p>
      </main>
    );
  }
  void actorId; // used by the audited APIs; the page itself only reads

  // ── 2. data, only reachable for MODERATOR/ADMIN ──
  const [moderation, reports] = await Promise.all([loadModerationQueue(), listOpenReports()]);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold text-[#D4AF37]">{t("title")}</h1>

      <section className="mt-6">
        <h2 className="text-lg font-semibold">{t("moderationQueue")}</h2>
        {moderation.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-400">{t("noEntries")}</p>
        ) : (
          moderation.map((item) => (
            <article key={item.trackId} className="mt-4 rounded border border-neutral-700 p-4">
              <h3 className="font-medium">{item.title}</h3>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-neutral-300">
                <dt>{t("status")}</dt>
                <dd>{t("statusPending")}</dd>
                <dt>{t("duration")}</dt>
                <dd>{t("durationValue", { seconds: Math.round(item.durationSec) })}</dd>
                <dt>{t("declarations")}</dt>
                <dd>
                  <div>
                    {item.aiGenerated ? t("declarationAi", { tool: item.aiTool ?? t("unknown") }) : t("declarationHuman")}
                  </div>
                  {item.humanContribution ? <div>{t("declarationContribution", { contribution: item.humanContribution })}</div> : null}
                  <div>{item.instrumental ? t("declarationInstrumental") : t("declarationLanguage", { language: item.language ?? t("unknown") })}</div>
                </dd>
                <dt>{t("aiSummary")}</dt>
                <dd>
                  <div>{item.aiSummary ?? t("noValue")}</div>
                  <div>{t("confidenceValue", { confidence: item.aiConfidence ?? t("noValue") })}</div>
                </dd>
                <dt>{t("fingerprint")}</dt>
                <dd>
                  {item.fingerprint ? (
                    <div>
                      <div>{item.fingerprint.strongMatch ? t("fingerprintStrong") : t("fingerprintWeak")}</div>
                      <div>{t("fingerprintScore", { score: item.fingerprint.bestScore ?? t("noValue") })}</div>
                      {item.fingerprint.recording ? <div>{t("fingerprintRecording", { recording: item.fingerprint.recording })}</div> : null}
                    </div>
                  ) : (
                    t("noValue")
                  )}
                </dd>
                <dt>{t("cost")}</dt>
                <dd>{t("costValue", { cost: item.costMicroUsd })}</dd>
                <dt>{t("policyVersion")}</dt>
                <dd>{item.policyVersion ?? t("noValue")}</dd>
                <dt>{t("auditTrail")}</dt>
                <dd>
                  {item.audits.map((a) => (
                    <div key={a.id} className="text-xs text-neutral-400">
                      {t("auditLine", { action: a.action, at: a.createdAt.toISOString() })}
                    </div>
                  ))}
                </dd>
              </dl>
              {item.transcript ? (
                <div className="mt-2">
                  <p className="text-xs uppercase text-neutral-500">{t("transcript")}</p>
                  {/* Untrusted text rendered as text, never as HTML (S5). */}
                  <TranscriptExcerpt text={item.transcript} />
                </div>
              ) : null}
              <TrackActions trackId={item.trackId} />
            </article>
          ))
        )}
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">{t("reportsQueue")}</h2>
        {reports.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-400">{t("noEntries")}</p>
        ) : (
          reports.map((report) => (
            <article key={report.id} className="mt-4 rounded border border-neutral-700 p-4">
              <h3 className="font-medium">{t("targetLabel", { targetType: report.targetType, targetId: report.targetId })}</h3>
              <p className="mt-1 text-sm text-neutral-300">{report.reason}</p>
              <p className="mt-1 text-xs text-neutral-400">
                {t("reportMeta", { category: report.category ?? t("noValue"), urgency: report.urgency })}
                {report.reporterContact ? (
                  <span> {t("reportContact", { contact: report.reporterContact })}</span>
                ) : null}
              </p>
              <ReportActions reportId={report.id} targetType={report.targetType} />
            </article>
          ))
        )}
      </section>
    </main>
  );
}
