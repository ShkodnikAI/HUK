"use client";

// H-122 task 5: the artist invite screen per Invite.dc.html — the board
// has only the code field; the API needs a handle and a display name too,
// so those two fields are added in the same style (reported in the PR).
// Every code failure (unknown, reused, malformed) mirrors the API's
// generic 404 — ONE message for all three (no oracle); 429 shows the wait
// time; success goes to the artist area (the submit page).

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Chip";
import { TextField } from "@/components/ui/TextField";

export function InviteScreen() {
  const t = useTranslations("auth.invite");
  const locale = useLocale();
  const router = useRouter();
  const [code, setCode] = useState("");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [waitMinutes, setWaitMinutes] = useState<number | null>(null);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setInvalid(false);
    setWaitMinutes(null);
    try {
      const res = await fetch("/api/invites/redeem", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim(), handle: handle.trim(), displayName: displayName.trim() }),
      });
      if (res.status === 404) {
        // Unknown, reused and malformed look the same — the API's contract.
        setInvalid(true);
        return;
      }
      if (res.status === 429) {
        const after = Number(res.headers.get("retry-after") ?? "0");
        setWaitMinutes(Math.max(1, Math.ceil(after / 60)));
        return;
      }
      if (res.ok) {
        router.push(`/${locale}/submit`);
        return;
      }
      setInvalid(true); // any other refusal: the same calm outcome
    } catch {
      setInvalid(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4">
      <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted">{t("explanation")}</p>
      <Card>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <TextField
            label={t("codeLabel")}
            value={code}
            required
            onChange={(e) => setCode(e.target.value)}
            helpText={t("codeHelp")}
          />
          <TextField
            label={t("handleLabel")}
            value={handle}
            required
            onChange={(e) => setHandle(e.target.value)}
            helpText={t("handleHelp")}
          />
          <TextField
            label={t("displayNameLabel")}
            value={displayName}
            required
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy ? t("redeeming") : t("redeem")}
          </Button>
        </form>
        {invalid && (
          <p role="alert" className="mt-3 rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
            {t("invalid")}
          </p>
        )}
        {waitMinutes !== null && (
          <p role="alert" className="mt-3 rounded-xl bg-gold-tint px-3 py-2 text-sm text-text">
            {t("rateLimited", { minutes: waitMinutes })}
          </p>
        )}
      </Card>
    </div>
  );
}
