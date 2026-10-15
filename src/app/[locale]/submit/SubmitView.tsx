"use client";

// H-123 task 4: the submission form per Submit.dc.html. One screen: title,
// the https link with the "must stay reachable and unchanged" explanation,
// the curated language select plus the instrumental flag, the "how it was
// made" declarations, optional lyrics with a counter and the plain-text
// rule, the two play-scope options, the rights checkbox (provisional
// wording, no terms link — the pages do not exist yet, D1/H-404) and the
// submit action. The direction selector from the board is intentionally
// absent (H-402 selection exists in the API, but the card keeps it out of
// scope). Errors map to the field that caused them; daily limits and the
// lyrics maximum are the values the server reports, never hard-coded.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Chip";
import { TextField } from "@/components/ui/TextField";

export type SubmitViewProps = {
  languages: Array<{ slug: string; label: string }>;
  tosVersion: string;
};

type MineLimits = { dailySubmissionsUsed: number; dailySubmissionsCap: number; lyricsMaxChars: number };

type ApiError = { error?: { code?: string; message?: string } };

async function errorCodeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as ApiError;
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

const RADIO_ONLY = "RADIO_ONLY";
const RADIO_AND_PLAYLISTS = "RADIO_AND_PLAYLISTS";

/** Form-level codes with a dedicated message; everything else is generic. */
const FORM_ERROR_CODES = new Set(["QUOTA_EXCEEDED", "RATE_LIMITED", "NETWORK", "VALIDATION_FAILED", "PAYLOAD_TOO_LARGE", "NO_ARTIST_PROFILE", "INVITE_REQUIRED"]);

function formErrorKey(code: string | null): string {
  if (code !== null && FORM_ERROR_CODES.has(code)) return `formError_${code}`;
  return "formError_generic";
}

export function SubmitView({ languages, tosVersion }: SubmitViewProps) {
  const t = useTranslations("submit");
  const tTaxonomy = useTranslations("taxonomy");
  const locale = useLocale();
  const router = useRouter();

  // ── field state ──
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [language, setLanguage] = useState(languages[0]?.slug ?? "other");
  const [instrumental, setInstrumental] = useState(false);
  const [aiGenerated, setAiGenerated] = useState(false);
  const [aiTool, setAiTool] = useState("");
  const [aiPlanAtCreation, setAiPlanAtCreation] = useState("");
  const [humanContribution, setHumanContribution] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [licenseScope, setLicenseScope] = useState<string>(RADIO_AND_PLAYLISTS);
  const [rightsChecked, setRightsChecked] = useState(false);

  // ── server-reported limits (never hard-coded) ──
  const [limits, setLimits] = useState<MineLimits | null>(null);

  // ── error state: per-field codes + one form-level code ──
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The limits ride in from GET /api/tracks/mine (the gate above already
    // proved the ARTIST session). rAF: no synchronous setState in effects.
    const raf = requestAnimationFrame(() => {
      void (async () => {
        try {
          const res = await fetch("/api/tracks/mine", { cache: "no-store" });
          if (!res.ok) return;
          const body = (await res.json()) as { limits?: MineLimits };
          if (body.limits) setLimits(body.limits);
        } catch {
          // The form still works; the server enforces the real limits.
        }
      })();
    });
    return () => cancelAnimationFrame(raf);
  }, []);

  const lyricsMax = limits?.lyricsMaxChars ?? null;

  const setFieldError = useCallback((field: string, code: string | null): void => {
    setFieldErrors((prev) => ({ ...prev, [field]: code }));
  }, []);

  const submit = useCallback(async (): Promise<void> => {
    setBusy(true);
    setFormError(null);
    setFieldErrors({});
    const trimmedTitle = title.trim();
    const trimmedUrl = url.trim();
    const clientGaps: Record<string, string | null> = {};
    if (trimmedTitle.length === 0) clientGaps.title = "REQUIRED";
    if (trimmedUrl.length === 0) clientGaps.url = "REQUIRED";
    if (!rightsChecked) clientGaps.rights = "REQUIRED";
    if (aiGenerated && (aiTool.trim() === "" || aiPlanAtCreation.trim() === "")) {
      clientGaps.aiTool = aiTool.trim() === "" ? "REQUIRED" : null;
      clientGaps.aiPlan = aiPlanAtCreation.trim() === "" ? "REQUIRED" : null;
    }
    if (Object.values(clientGaps).some((v) => v !== null)) {
      setFieldErrors(clientGaps);
      setBusy(false);
      return;
    }

    const payload = {
      title: trimmedTitle,
      source: { provider: "DIRECT_URL", url: trimmedUrl },
      rightsOwned: true,
      aiGenerated,
      aiTool: aiGenerated ? aiTool.trim() : undefined,
      aiPlanAtCreation: aiGenerated ? aiPlanAtCreation.trim() : undefined,
      humanContribution: humanContribution.trim(),
      language: instrumental ? undefined : language,
      instrumental,
      lyrics: lyrics.trim() === "" ? undefined : lyrics,
      licenseScope,
      tosVersion,
    };

    let res: Response | null = null;
    try {
      res = await fetch("/api/tracks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      setFormError("NETWORK");
      setBusy(false);
      return;
    }

    if (res.status === 201) {
      router.push(`/${locale}/cabinet`);
      return;
    }
    const code = await errorCodeOf(res);
    // Field mapping: each API error lands on the field that caused it.
    if (code === "SOURCE_UNREACHABLE") setFieldError("url", code);
    else if (code === "LYRICS_TOO_LONG" || code === "LYRICS_FORBIDDEN_CHARS" || code === "LYRICS_LINK_FORBIDDEN") {
      setFieldError("lyrics", code);
    } else setFormError(code);
    setBusy(false);
  }, [aiGenerated, aiPlanAtCreation, aiTool, humanContribution, instrumental, language, licenseScope, locale, lyrics, rightsChecked, router, setFieldError, title, tosVersion, url]);

  const errorText = (field: string): string | null => {
    const code = fieldErrors[field];
    if (!code) return null;
    return code === "REQUIRED" ? t("errorRequired") : t(`error_${code}`);
  };

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-10">
      <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
      <p className="text-sm text-muted">{t("intro")}</p>

      {limits ? (
        <p className="text-sm text-muted">
          {t("quotaLine", { used: limits.dailySubmissionsUsed, cap: limits.dailySubmissionsCap })}
        </p>
      ) : null}

      <Card className="flex flex-col gap-4">
        <TextField
          label={t("titleLabel")}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          errorText={errorText("title")}
        />
        <TextField
          label={t("urlLabel")}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          helpText={t("urlHelp")}
          errorText={errorText("url")}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="submit-language" className="text-sm font-medium text-muted">
            {t("languageLabel")}
          </label>
          <select
            id="submit-language"
            className="focus-gold min-h-[44px] w-full rounded-xl border border-border bg-sunken px-3 text-text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            disabled={instrumental}
            aria-disabled={instrumental}
          >
            {languages.map((l) => (
              <option key={l.slug} value={l.slug}>
                {tTaxonomy(`language.${l.slug}`)}
              </option>
            ))}
          </select>
          <label className="mt-1 flex min-h-[44px] items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-gold"
              checked={instrumental}
              onChange={(e) => setInstrumental(e.target.checked)}
            />
            {t("instrumental")}
          </label>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gold">{t("madeSection")}</legend>
          <label className="flex min-h-[44px] items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="h-5 w-5 accent-gold"
              checked={aiGenerated}
              onChange={(e) => setAiGenerated(e.target.checked)}
            />
            {t("aiGenerated")}
          </label>
          {aiGenerated ? (
            <div className="flex flex-col gap-3">
              <TextField
                label={t("aiToolLabel")}
                value={aiTool}
                maxLength={200}
                onChange={(e) => setAiTool(e.target.value)}
                errorText={errorText("aiTool")}
              />
              <TextField
                label={t("aiPlanLabel")}
                value={aiPlanAtCreation}
                maxLength={2000}
                onChange={(e) => setAiPlanAtCreation(e.target.value)}
                errorText={errorText("aiPlan")}
              />
            </div>
          ) : null}
          <TextField
            label={t("humanLabel")}
            value={humanContribution}
            maxLength={500}
            onChange={(e) => setHumanContribution(e.target.value)}
            helpText={t("humanHelp")}
          />
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gold">{t("lyricsSection")}</legend>
          <label htmlFor="submit-lyrics" className="text-sm text-muted">
            {t("lyricsLabel")}
          </label>
          <textarea
            id="submit-lyrics"
            className="focus-gold w-full rounded-xl border border-border bg-sunken px-3 py-2 text-text"
            rows={6}
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            aria-describedby="submit-lyrics-note"
            aria-invalid={fieldErrors["lyrics"] ? true : undefined}
          />
          <div className="flex flex-col gap-1">
            <p id="submit-lyrics-note" className="text-xs text-muted">
              {t("lyricsNote")}
            </p>
            <p className="text-xs text-muted" aria-live="polite">
              {lyrics.length}
              {lyricsMax !== null ? ` / ${lyricsMax}` : ""}
            </p>
            {errorText("lyrics") ? (
              <p role="alert" className="text-xs text-danger">
                {errorText("lyrics")}
              </p>
            ) : null}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-semibold uppercase tracking-widest text-gold">{t("scopeSection")}</legend>
          <label className="flex min-h-[44px] items-center gap-3 text-sm">
            <input
              type="radio"
              name="licenseScope"
              className="h-5 w-5 accent-gold"
              value={RADIO_AND_PLAYLISTS}
              checked={licenseScope === RADIO_AND_PLAYLISTS}
              onChange={() => setLicenseScope(RADIO_AND_PLAYLISTS)}
            />
            {t("scopeRadioAndPlaylists")}
          </label>
          <label className="flex min-h-[44px] items-center gap-3 text-sm">
            <input
              type="radio"
              name="licenseScope"
              className="h-5 w-5 accent-gold"
              value={RADIO_ONLY}
              checked={licenseScope === RADIO_ONLY}
              onChange={() => setLicenseScope(RADIO_ONLY)}
            />
            {t("scopeRadioOnly")}
          </label>
        </fieldset>

        <div className="flex flex-col gap-1">
          <label className="flex items-start gap-3 text-sm leading-snug">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 flex-none accent-gold"
              checked={rightsChecked}
              onChange={(e) => setRightsChecked(e.target.checked)}
            />
            {t("rightsCheckbox")}
          </label>
          {errorText("rights") ? (
            <p role="alert" className="text-xs text-danger">
              {errorText("rights")}
            </p>
          ) : null}
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {t(formErrorKey(formError))}
          </p>
        ) : null}

        <Button onClick={() => void submit()} disabled={busy}>
          {t("submitButton")}
        </Button>
        <p className="text-center text-xs text-muted">{t("checksNote")}</p>
      </Card>
    </main>
  );
}
