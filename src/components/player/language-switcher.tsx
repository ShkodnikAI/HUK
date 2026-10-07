"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";

// Language switcher (H-105): swaps the leading [locale] segment of the
// current path. The two locales come from the shared routing config.
const LOCALES = ["en", "ru"] as const;

export function LanguageSwitcher() {
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("language");

  const rest = pathname.split("/").slice(2).join("/");
  return (
    <nav aria-label={t("label")} className="flex gap-2 text-sm">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={l === locale ? pathname : `/${l}${rest ? `/${rest}` : ""}`}
          hrefLang={l}
          aria-current={l === locale ? "true" : undefined}
          className={l === locale ? "font-semibold text-[#D4AF37]" : "text-neutral-400"}
        >
          {l.toUpperCase()}
        </Link>
      ))}
    </nav>
  );
}
