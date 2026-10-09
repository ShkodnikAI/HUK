"use client";

// The chart-type tabs (H-305): keyboard-operable (roving focus is native
// for links; the tablist carries aria-label and aria-selected), rendered
// as links so the state lives in the URL (?kind=…&cat=…).

import Link from "next/link";

export type ChartKind = "all" | "language" | "style" | "direction" | "instrumental";

const GOLD = "#D4AF37";
const TEXT = "#ECEBE6";
const SURFACE = "#23242A";
const BORDER = "#34353C";
const RAISED = "#2C2D34";

export function ChartTabs({
  kinds,
  activeKind,
  publishedKinds,
  locale,
  labels,
}: {
  kinds: ChartKind[];
  activeKind: ChartKind;
  publishedKinds: ChartKind[];
  locale: string;
  labels: Record<ChartKind, string>;
}) {
  return (
    <div role="tablist" aria-label="Chart type" style={{ display: "flex", gap: 8, padding: "16px 0 0 0", flexWrap: "wrap" }}>
      {kinds.map((kind) => {
        const hasContent = kind === "all" ? true : publishedKinds.includes(kind);
        const active = kind === activeKind;
        return (
          <Link
            key={kind}
            role="tab"
            aria-selected={active}
            aria-disabled={!hasContent}
            href={`/${locale}/charts?kind=${kind}`}
            style={{
              minHeight: 44,
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              borderRadius: 22,
              border: `1px solid ${active ? GOLD : BORDER}`,
              backgroundColor: active ? RAISED : SURFACE,
              color: active ? GOLD : hasContent ? TEXT : "#7A7B80",
              fontSize: 13,
              fontWeight: active ? 600 : 500,
              textDecoration: "none",
              opacity: hasContent ? 1 : 0.6,
            }}
          >
            {labels[kind]}
          </Link>
        );
      })}
    </div>
  );
}
