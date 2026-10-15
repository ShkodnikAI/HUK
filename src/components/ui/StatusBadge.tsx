// H-120 task 4: StatusBadge — ALWAYS a word plus a colour, never colour
// alone (the accessibility rule of the design). `children` is required:
// the caller must pass the status word from the catalog.

import type { ReactNode } from "react";

export type StatusTone = "success" | "danger" | "pending" | "paused";

const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-bg text-success", // on air, redeemed
  danger: "bg-danger-bg text-danger", // not accepted, removed
  pending: "bg-gold-tint text-text", // in review
  paused: "bg-gold-tint text-text", // paused
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-3xl px-2.5 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
