"use client";

// H-120 task 4: base Button — primary (gold, dark text), secondary
// (raised surface), ghost. Minimum height 44 px (primary 48 px, TOKENS.md);
// the gold focus ring for keyboard users.

import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "min-h-[48px] bg-gold px-5 font-semibold text-background hover:brightness-110",
  secondary: "min-h-[44px] bg-raised px-4 font-medium text-text hover:bg-border",
  ghost: "min-h-[44px] bg-transparent px-3 font-medium text-muted hover:text-text",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function Button({ variant = "primary", className = "", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`focus-gold inline-flex items-center justify-center gap-2 rounded-xl transition-colors disabled:pointer-events-none disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className}`}
      {...rest}
    />
  );
}
