"use client";

// H-122: shared locale bridge for the NON-localised Auth.js pages
// (/signin, /check-email, /auth-error). Auth.js redirects to fixed paths
// with its own query params, so these pages cannot redirect again without
// losing them; instead they resolve the locale in place — the NEXT_LOCALE
// cookie set by the language switcher, then navigator.languages, then en —
// and render their screen under a scoped message provider.

import { NextIntlClientProvider } from "next-intl";
import { useEffect, useState, type ReactNode } from "react";
import en from "../../../messages/en.json";
import ru from "../../../messages/ru.json";

const CATALOGS: Record<string, typeof en> = { en, ru };

function resolveLocale(): string {
  if (typeof document !== "undefined") {
    const match = document.cookie.match(/(?:^|;\s*)NEXT_LOCALE=([a-z-]+)/);
    if (match && CATALOGS[match[1]]) return match[1];
  }
  if (typeof navigator !== "undefined") {
    for (const tag of navigator.languages ?? []) {
      const base = tag.split("-")[0];
      if (CATALOGS[base]) return base;
    }
  }
  return "en";
}

export function LocaleBridge({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<string | null>(null);
  useEffect(() => {
    // rAF: no synchronous setState in an effect body.
    const raf = requestAnimationFrame(() => setLocale(resolveLocale()));
    return () => cancelAnimationFrame(raf);
  }, []);
  // First paint waits one client tick — a flash of the wrong locale is
  // worse than a blank frame on a boot screen.
  if (locale === null) return null;
  return (
    <NextIntlClientProvider locale={locale} messages={CATALOGS[locale]} now={new Date()}>
      {children}
    </NextIntlClientProvider>
  );
}
