// H-120 task 5: the "the station is silent" quiet state (the States board,
// docs/design/screens-v1/States.dc.html). H-121 wires it into the radio
// screen when /now answers current:null and next:[]. Word + visual, no
// colour-only meaning; strings come from the catalog.

import { useTranslations } from "next-intl";

export function QuietState() {
  const t = useTranslations("states");
  return (
    <div
      role="status"
      className="mx-auto flex max-w-md flex-col items-center gap-3 rounded-2xl border border-border bg-surface px-6 py-10 text-center"
    >
      {/* Static waveform — a quiet line, not an animation. */}
      <svg aria-hidden="true" viewBox="0 0 96 12" className="h-3 w-24 text-muted" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <line x1="0" y1="6" x2="96" y2="6" strokeWidth="0.8" />
        <line x1="14" y1="3" x2="14" y2="9" />
        <line x1="28" y1="1.5" x2="28" y2="10.5" />
        <line x1="48" y1="4.5" x2="48" y2="7.5" />
        <line x1="68" y1="1.5" x2="68" y2="10.5" />
        <line x1="82" y1="3" x2="82" y2="9" />
      </svg>
      <p className="font-display text-xl font-semibold">{t("quietTitle")}</p>
      <p className="text-sm text-muted">{t("quietText")}</p>
    </div>
  );
}
