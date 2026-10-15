// H-120 task 4: Chip (a pill) and Card (a surface block). Server-safe
// presentational components.

import type { HTMLAttributes, ReactNode } from "react";

export function Chip({ className = "", ...rest }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={`focus-gold inline-flex min-h-[32px] items-center rounded-3xl bg-raised px-3 py-1 text-xs font-medium text-muted ${className}`}
      {...rest}
    />
  );
}

export function Card({ className = "", children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-4 ${className}`} {...rest}>
      {children}
    </div>
  );
}
