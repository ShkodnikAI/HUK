// /charts (H-305): the public charts screen, following the Owner-approved
// design docs/design/screens-v1/Charts.dc.html (phone) and
// DesktopCharts.dc.html (desktop) — the tokens are the v1 dark values of
// docs/design/screens-v1/TOKENS.md applied literally. Deviations, on the
// record: the app shell (bottom navigation, top bar), the self-hosted
// fonts and the Charts navigation flag are H-120 (#91) deliverables and
// arrive with that naryad; until then the page renders standalone with the
// system font stack and no third-party requests. Rows link nowhere yet —
// the track page ships with the UI wave (H-124, planned); the design boards
// show no play control on chart rows.

import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { chartIndex, chartTop } from "@/server/charts/service";
import { parseCategoryKey, PUBLISHED_MIN_TRACKS } from "@/server/charts/categories";
import { MIN_VOTERS } from "@/server/ranking/signals";
import { ChartTabs } from "@/components/charts/chart-tabs";

export const dynamic = "force-dynamic";

const KINDS = ["all", "language", "style", "direction", "instrumental"] as const;
type Kind = (typeof KINDS)[number];

/** Categories grouped by their parsed kind, for the tab + selector state. */
function kindOf(key: string): Kind {
  const parsed = parseCategoryKey(key);
  if (!parsed) return "all";
  if (parsed.kind === "language" || parsed.kind === "lang+style") return "language";
  if (parsed.kind === "style") return "style";
  if (parsed.kind === "direction") return "direction";
  if (parsed.kind === "instrumental") return "instrumental";
  return "all";
}

const GOLD = "#D4AF37";
const TEXT = "#ECEBE6";
const MUTED = "#A3A4A9";
const SURFACE = "#23242A";
const BORDER = "#34353C";
const RAISED = "#2C2D34";

export default async function ChartsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string; cat?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("charts");

  const published = await chartIndex();
  const query = await searchParams;
  const requestedKind = (KINDS as readonly string[]).includes(query.kind ?? "") ? (query.kind as Kind) : null;
  const requestedCat = query.cat && parseCategoryKey(query.cat) !== null ? query.cat : null;

  // A category shows only if it is published; an unpublished or unknown
  // request falls back to the first published category of the kind, then
  // to the quiet state (S9: no fabricated data).
  const kind = requestedKind ?? (requestedCat ? kindOf(requestedCat) : null);
  const byKind = new Map<Kind, typeof published>();
  for (const entry of published) {
    const k = kindOf(entry.key);
    byKind.set(k, [...(byKind.get(k) ?? []), entry]);
  }
  const categoriesOfKind = kind ? (byKind.get(kind) ?? []) : [];
  const activeKey =
    requestedCat && categoriesOfKind.some((c) => c.key === requestedCat)
      ? requestedCat
      : (categoriesOfKind[0]?.key ?? (kind === "all" && published.some((p) => p.key === "all") ? "all" : null));

  const entries = activeKey ? await chartTop(activeKey) : [];

  return (
    <main style={{ minHeight: "60vh", backgroundColor: "#1A1B1F", color: TEXT }}>
      <header style={{ padding: "22px 20px 0 20px", maxWidth: 1100, margin: "0 auto" }}>
        <h1 style={{ margin: 0, fontWeight: 600, fontSize: 36, lineHeight: 1.1, color: TEXT }}>{t("title")}</h1>
        <p style={{ margin: "6px 0 0 0", fontSize: 13, color: MUTED }}>
          {t("subtitle")}{" "}
          <Link href={`/${locale}/charts/how`} style={{ color: GOLD }}>
            {t("howLink")}
          </Link>
        </p>
      </header>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "0 20px 40px 20px" }}>
        <ChartTabs
          kinds={[...KINDS]}
          activeKind={kind ?? "all"}
          publishedKinds={[...new Set(published.map((p) => kindOf(p.key)))]}
          locale={locale}
          labels={{
            all: t("kindAll"),
            language: t("kindLanguage"),
            style: t("kindStyle"),
            direction: t("kindDirection"),
            instrumental: t("kindInstrumental"),
          }}
        />

        {kind && kind !== "all" && categoriesOfKind.length > 0 && (
          <div style={{ padding: "12px 0 0 0" }}>
            <details>
              <summary
                style={{
                  width: "100%",
                  minHeight: 44,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "0 14px",
                  borderRadius: 12,
                  border: `1px solid ${BORDER}`,
                  backgroundColor: SURFACE,
                  color: TEXT,
                  fontSize: 14,
                  cursor: "pointer",
                  listStyle: "none",
                }}
              >
                <span>{activeKey ?? ""}</span>
                <span style={{ color: MUTED }}>{t("selectCategory")}</span>
              </summary>
              <ul style={{ listStyle: "none", margin: "8px 0 0 0", padding: 0 }}>
                {categoriesOfKind.map((category) => (
                  <li key={category.key}>
                    <Link
                      href={`/${locale}/charts?kind=${kind}&cat=${encodeURIComponent(category.key)}`}
                      style={{
                        minHeight: 44,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "0 14px",
                        borderRadius: 12,
                        border: `1px solid ${category.key === activeKey ? GOLD : BORDER}`,
                        backgroundColor: SURFACE,
                        color: TEXT,
                        fontSize: 14,
                        textDecoration: "none",
                        marginTop: 4,
                      }}
                    >
                      <span>{category.key}</span>
                      <span style={{ color: MUTED }}>{category.tracks}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}

        {entries.length === 0 ? (
          <p style={{ margin: "24px 0 0 0", fontSize: 15, color: MUTED }}>{t("empty")}</p>
        ) : (
          <ol style={{ listStyle: "none", margin: "14px 0 0 0", padding: 0 }}>
            {entries.map((entry) => (
              <li
                key={entry.trackId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  minHeight: 64,
                  borderBottom: `1px solid ${RAISED}`,
                }}
              >
                <span
                  style={{
                    width: 28,
                    fontSize: 20,
                    fontWeight: 600,
                    color: entry.rank === 1 ? GOLD : TEXT,
                    textAlign: "center",
                  }}
                >
                  {entry.rank}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontSize: 15, fontWeight: 600, color: TEXT }}>{entry.title}</span>
                  <span style={{ fontSize: 13, color: MUTED }}>{entry.artist ?? t("unknownArtist")}</span>
                </div>
                <span style={{ fontSize: 12, color: MUTED }}>{t("likes", { count: entry.likes })}</span>
              </li>
            ))}
          </ol>
        )}

        <p style={{ margin: "12px 0 0 0", fontSize: 12, lineHeight: 1.5, color: MUTED }}>
          {t("footnote", { minVoters: MIN_VOTERS, minTracks: PUBLISHED_MIN_TRACKS })}
        </p>
      </div>
    </main>
  );
}
