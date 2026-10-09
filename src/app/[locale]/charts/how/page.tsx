// /charts/how (H-305): the "How charts work" screen per the Owner-approved
// design docs/design/screens-v1/HowCharts.dc.html. Every number on the page
// comes from howChartsFigures() (read from src/server/ranking/signals.ts)
// through the message catalogs — a contract test pins the figures to the
// constants, so the prose cannot drift from the algorithm. Dislikes are
// acknowledged here and never shown anywhere else. AI never decides
// positions — the identity rule (AGENTS §2).

import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { howChartsFigures } from "@/server/charts/figures";

export const dynamic = "force-dynamic";

const GOLD = "#D4AF37";
const TEXT = "#ECEBE6";
const MUTED = "#A3A4A9";
const SURFACE = "#23242A";
const BORDER = "#34353C";
const RAISED = "#2C2D34";

export default async function HowChartsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("charts");
  const f = howChartsFigures();

  const section = (title: string, body: string) => (
    <>
      <h2 style={{ margin: "28px 0 8px 0", fontSize: 20, fontWeight: 600, color: TEXT }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.65, color: MUTED }}>{body}</p>
    </>
  );

  return (
    <main style={{ minHeight: "60vh", backgroundColor: "#1A1B1F", color: TEXT }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 40, maxWidth: 1100, margin: "0 auto", padding: 40 }}>
        <article style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 680 }}>
          <h1 style={{ margin: 0, fontWeight: 600, fontSize: 48, lineHeight: 1.1, color: TEXT }}>{t("howTitle")}</h1>
          <p style={{ margin: "14px 0 0 0", fontSize: 17, lineHeight: 1.6, color: TEXT }}>{t("howIntro")}</p>

          {section(
            t("howWhatCountsTitle"),
            t("howWhatCounts", {
              likeWeight: f.likeWeight,
              dislikeWeight: f.dislikeWeight,
              playlistAddWeight: f.playlistAddWeight,
              completionWeight: f.completionWeight,
              repeatCompletionWeight: f.repeatCompletionWeight,
              earlySkipWeight: f.earlySkipWeight,
            }),
          )}
          {section(t("howDecayTitle"), t("howDecay", { halfLifeDays: f.halfLifeDays }))}
          {section(
            t("howWilsonTitle"),
            t("howWilson", { confidenceLevelPct: f.confidenceLevelPct, minVoters: f.minVoters }),
          )}
          {section(t("howFairPlayTitle"), t("howFairPlay", { reactionUnlockSeconds: f.reactionUnlockSeconds }))}
          {section(t("howFreshTitle"), t("howFresh", { freshPoolSize: f.freshPoolSize }))}
        </article>

        <aside
          aria-label="Legal"
          style={{ flex: "1 1 260px", minWidth: 0, alignSelf: "flex-start", padding: 20, borderRadius: 16, backgroundColor: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <h2 style={{ margin: "0 0 10px 0", fontSize: 13, fontWeight: 600, letterSpacing: "0.08em", color: GOLD }}>
            {t("howLegalTitle")}
          </h2>
          <p style={{ margin: "10px 0 0 0", fontSize: 12, lineHeight: 1.55, color: MUTED }}>{t("howLegalNote")}</p>
          <p style={{ margin: "10px 0 0 0", fontSize: 12, lineHeight: 1.55, color: MUTED }}>
            {t("howRollupNote", { minTracks: f.publishedMinTracks })}
          </p>
        </aside>
      </div>
      <p style={{ maxWidth: 1100, margin: "0 auto", padding: "0 40px 40px 40px" }}>
        <Link href={`/${locale}/charts`} style={{ color: GOLD, minHeight: 44, display: "inline-flex", alignItems: "center" }}>
          {t("howBackToCharts")}
        </Link>
      </p>
    </main>
  );
}
