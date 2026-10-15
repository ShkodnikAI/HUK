"use client";

// H-122 task 3: the check-your-email screen per CheckEmail.dc.html — the
// address that was entered (sessionStorage, set by the sign-in screen),
// "use another address", a spam hint, and NO countdown (no delivery
// guarantees are implied).

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Chip";

export function CheckEmailScreen() {
  const t = useTranslations("auth.checkEmail");
  const locale = useLocale();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    // rAF: no synchronous setState in an effect body.
    const raf = requestAnimationFrame(() => setEmail(sessionStorage.getItem("huk-signin-email")));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <Card>
        <h1 className="font-display text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-sm text-text">
          {email ? t("sentTo", { email }) : t("sentGeneric")}
        </p>
        <p className="mt-3 text-sm text-muted">{t("hint")}</p>
        <p className="mt-1 text-sm text-muted">{t("spamHint")}</p>
        <Link
          href={`/${locale}/signin`}
          className="focus-gold mt-4 inline-flex min-h-[44px] items-center rounded-xl bg-raised px-4 text-sm font-medium text-text hover:bg-border"
        >
          {t("useAnotherAddress")}
        </Link>
      </Card>
    </div>
  );
}
