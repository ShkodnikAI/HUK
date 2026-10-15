"use client";

// H-120 task 5: the 404 page (the States board). Heading + text + a link
// back to the radio. Catalog strings only.

import Link from "next/link";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations("states");
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <p className="font-display text-6xl font-semibold text-gold" aria-hidden="true">
        {t("notFoundCode")}
      </p>
      <h1 className="font-display text-2xl font-semibold">{t("notFoundTitle")}</h1>
      <p className="max-w-sm text-sm text-muted">{t("notFoundText")}</p>
      <Link
        href="/"
        className="focus-gold mt-2 inline-flex min-h-[44px] items-center rounded-xl bg-gold px-5 font-semibold text-background hover:brightness-110"
      >
        {t("backToRadio")}
      </Link>
    </div>
  );
}
