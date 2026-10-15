"use client";

// H-122 task 4: the error screen for an expired, used or otherwise broken
// magic link. Auth.js appends ?error=<code> (Verification, Configuration,
// ...) — EVERY error value gets the same plain words (no internal detail,
// no provider detail, no stack trace), with a button back to sign-in.

import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/Chip";
import { Button } from "@/components/ui/Button";

export function AuthErrorScreen() {
  const t = useTranslations("auth.error");
  const locale = useLocale();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    // Read the Auth.js error param off the effect body (rAF: no synchronous
    // setState in an effect) — and deliberately keep it internal.
    const raf = requestAnimationFrame(() => {
      const params = new URLSearchParams(window.location.search);
      setCode(params.get("error"));
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  // The code is deliberately NOT shown: plain words for every error value.
  void code;

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <Card>
        <h1 className="font-display text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-2 text-sm text-text">{t("explanation")}</p>
        <Link href={`/${locale}/signin`} className="focus-gold mt-4 inline-flex rounded-xl">
          <Button>{t("backToSignIn")}</Button>
        </Link>
      </Card>
    </div>
  );
}
