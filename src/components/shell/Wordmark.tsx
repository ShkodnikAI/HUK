"use client";

// The HUK wordmark (docs/BRAND.md §2): H in gold with the crossbar
// replaced by an audio waveform, UK in the wordmark grey. The descriptor
// and tagline are board-level lockups — the shell carries the compact
// form. No hard-coded hex: the colours come from the token classes. The
// brand glyphs go through the catalog (the H-105 rule): their values are
// identical in both locales — the Latin lockup is the brand (BRAND.md §1).

import { useTranslations } from "next-intl";

export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  const t = useTranslations("shell");
  const text = size === "lg" ? "text-4xl sm:text-5xl" : "text-2xl";
  return (
    <span className={`inline-flex items-baseline font-display font-semibold tracking-wide ${text}`}>
      <span className="relative inline-flex items-center justify-center text-gold">
        {t("wordmarkFirst")}
        {/* the waveform crossbar, drawn over the letter's middle line */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 8"
          className="absolute left-1/2 top-1/2 h-[0.32em] w-[1.6em] -translate-x-1/2 -translate-y-1/2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* thin baseline slightly past both stems */}
          <line x1="0" y1="4" x2="24" y2="4" strokeWidth="0.8" />
          <polyline points="4,4 6,1.2 8,6.8 10,2.4 12,5.6 14,4 16,4" />
        </svg>
      </span>
      <span className="text-wordmark">{t("wordmarkRest")}</span>
    </span>
  );
}
