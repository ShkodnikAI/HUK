"use client";

// H-123 task 5: the cabinet view per Cabinet.dc.html. Each track: the
// title, the status badge in words (colour never alone), the statement of
// reasons where the API gives one, and "Edit lyrics" — an inline editor
// over PATCH /api/tracks/[id]/lyrics (save and remove both go through the
// same route; removal sends null). The quota line is the value the server
// reports; if the API did not expose it, the line is omitted entirely.
// Lyrics are plain text (S5): displayed in a <p>, never as HTML.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Chip";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";

export type CabinetTrack = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  licenseScope: string;
  lyrics: string | null;
  likes: number;
  statementOfReasons: string | null;
};

type CabinetLimits = { dailySubmissionsUsed: number; dailySubmissionsCap: number; lyricsMaxChars: number };

type ApiError = { error?: { code?: string; message?: string } };

async function errorCodeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as ApiError;
    return body.error?.code ?? null;
  } catch {
    return null;
  }
}

/** Status → badge tone (H-120 rule: the word carries the meaning). */
function toneForStatus(status: string): StatusTone {
  if (status === "APPROVED") return "success";
  if (status === "REJECTED" || status === "TAKEN_DOWN") return "danger";
  if (status === "SUSPENDED") return "paused";
  return "pending"; // PENDING, DRAFT
}

function statusKey(status: string): string {
  // DRAFT cannot be created through submission; the word still exists so
  // the badge never falls back to a raw enum value.
  const known: Record<string, string> = {
    PENDING: "statusInReview",
    APPROVED: "statusOnAir",
    REJECTED: "statusNotAccepted",
    SUSPENDED: "statusPaused",
    TAKEN_DOWN: "statusRemoved",
    DRAFT: "statusDraft",
  };
  return known[status] ?? "statusInReview";
}

export function CabinetView() {
  const t = useTranslations("cabinet");
  const locale = useLocale();
  const [tracks, setTracks] = useState<CabinetTrack[] | null>(null);
  const [limits, setLimits] = useState<CabinetLimits | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Inline lyrics editor state: which track is open, its draft text and
  // the per-track error code.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/tracks/mine", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        setTracks(null);
        return;
      }
      const body = (await res.json()) as { tracks?: CabinetTrack[]; limits?: CabinetLimits };
      setTracks(body.tracks ?? []);
      if (body.limits) setLimits(body.limits);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    const raf = requestAnimationFrame(() => void reload());
    return () => cancelAnimationFrame(raf);
  }, [reload]);

  const openEditor = useCallback((track: CabinetTrack): void => {
    setEditingId(track.id);
    setDraft(track.lyrics ?? "");
    setEditError(null);
  }, []);

  const closeEditor = useCallback((): void => {
    setEditingId(null);
    setDraft("");
    setEditError(null);
  }, []);

  const saveLyrics = useCallback(
    async (trackId: string, lyrics: string | null): Promise<void> => {
      setSaving(true);
      setEditError(null);
      let res: Response | null = null;
      try {
        res = await fetch(`/api/tracks/${encodeURIComponent(trackId)}/lyrics`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lyrics }),
        });
      } catch {
        setEditError("NETWORK");
        setSaving(false);
        return;
      }
      if (res.ok) {
        closeEditor();
        await reload();
        setSaving(false);
        return;
      }
      const code = await errorCodeOf(res);
      setEditError(code ?? "GENERIC");
      setSaving(false);
    },
    [closeEditor, reload],
  );

  if (tracks === null) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col gap-4 px-6 py-10">
        <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted">{loadError ? t("loadError") : t("loading")}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-6 py-10">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-3xl font-semibold">{t("title")}</h1>
        <Link
          href={`/${locale}/submit`}
          className="focus-gold inline-flex min-h-[44px] items-center rounded-full bg-gold px-4 font-semibold text-background hover:brightness-110"
        >
          {t("submitButton")}
        </Link>
      </div>

      {limits ? (
        <p className="text-sm text-muted">
          {t("quotaLine", { used: limits.dailySubmissionsUsed, cap: limits.dailySubmissionsCap })}
        </p>
      ) : null}

      {tracks.length === 0 ? (
        <Card>
          <p className="text-sm text-muted">{t("emptyText")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {tracks.map((track) => (
            <li key={track.id}>
              <Card className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-semibold">{track.title}</span>
                  <StatusBadge tone={toneForStatus(track.status)}>{t(statusKey(track.status))}</StatusBadge>
                </div>
                {track.statementOfReasons ? (
                  <p className="text-sm text-muted">{t("reasonLine", { reason: track.statementOfReasons })}</p>
                ) : null}
                {track.status === "PENDING" ? <p className="text-sm text-muted">{t("waitingHint")}</p> : null}
                {track.status === "SUSPENDED" ? <p className="text-sm text-muted">{t("pausedHint")}</p> : null}

                {editingId === track.id ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor={`lyrics-${track.id}`} className="text-sm font-medium text-muted">
                      {t("editLyricsLabel")}
                    </label>
                    <textarea
                      id={`lyrics-${track.id}`}
                      className="focus-gold w-full rounded-xl border border-border bg-sunken px-3 py-2 text-text"
                      rows={6}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    {editError ? (
                      <p role="alert" className="text-xs text-danger">
                        {t(
                          editError === "LYRICS_TOO_LONG" || editError === "LYRICS_FORBIDDEN_CHARS" || editError === "LYRICS_LINK_FORBIDDEN"
                            ? `error_${editError}`
                            : editError === "RATE_LIMITED"
                              ? "error_RATE_LIMITED"
                              : editError === "NETWORK"
                                ? "error_NETWORK"
                                : "error_generic",
                        )}
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => void saveLyrics(track.id, draft)} disabled={saving}>
                        {t("saveLyrics")}
                      </Button>
                      <Button variant="secondary" onClick={closeEditor} disabled={saving}>
                        {t("cancelEdit")}
                      </Button>
                      <Button variant="secondary" onClick={() => void saveLyrics(track.id, null)} disabled={saving}>
                        {t("removeLyrics")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() => openEditor(track)}
                      className="focus-gold min-h-[44px] w-fit rounded px-1 text-left text-sm font-medium text-gold hover:underline"
                    >
                      {t("editLyrics")}
                    </button>
                    {/* Untrusted text rendered as text, never as HTML (S5). */}
                    {track.lyrics ? <p className="whitespace-pre-wrap break-words text-sm text-muted">{track.lyrics}</p> : null}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted">{t("dislikesNote")}</p>
    </main>
  );
}
