"use client";

// H-122 task 2: the sign-in screen per SignIn.dc.html — one email field,
// one button, "a link will be sent", NO password field, NO account-creation
// split (the first link creates the account). The response is identical
// whether or not the address is known (no account oracle): every non-429
// outcome leads to the check-your-email screen. Rate-limit responses show
// a calm message with the wait time. The CSRF handshake uses Auth.js's own
// endpoints (/api/auth/csrf -> csrfToken posted back) — CSRF checks stay
// fully intact.

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";

export function SignInScreen() {
  const t = useTranslations("auth.signin");
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitMinutes, setWaitMinutes] = useState<number | null>(null);
  const [genericProblem, setGenericProblem] = useState(false);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setWaitMinutes(null);
    setGenericProblem(false);
    try {
      // The provider's own CSRF handshake: GET the token, POST it back.
      const csrfRes = await fetch("/api/auth/csrf", { cache: "no-store" });
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
      const form = new FormData();
      form.set("email", email.trim());
      form.set("csrfToken", csrfToken);
      form.set("callbackUrl", `${window.location.origin}/${locale}/me`);
      const res = await fetch("/api/auth/signin/email", {
        method: "POST",
        body: form,
        redirect: "manual", // Auth.js answers a redirect; the screen navigates itself
      });
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after") ?? "0");
        setWaitMinutes(Math.max(1, Math.ceil(after / 60)));
        return;
      }
      // Success AND any Auth.js redirect look the same here — deliberately:
      // the response must not depend on whether the address is known.
      sessionStorage.setItem("huk-signin-email", email.trim());
      router.push(`/${locale}/check-email`);
    } catch {
      setGenericProblem(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted">{t("explanation")}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          label={t("emailLabel")}
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          helpText={t("emailHelp")}
        />
        <Button type="submit" disabled={busy || email.trim().length < 3}>
          {busy ? t("sending") : t("sendLink")}
        </Button>
      </form>
      {waitMinutes !== null && (
        <p role="alert" className="rounded-xl bg-gold-tint px-3 py-2 text-sm text-text">
          {t("rateLimited", { minutes: waitMinutes })}
        </p>
      )}
      {genericProblem && (
        <p role="alert" className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
          {t("genericProblem")}
        </p>
      )}
      <p className="text-xs text-muted">{t("noPasswordNote")}</p>
    </div>
  );
}
