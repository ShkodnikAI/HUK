"use client";

// H-121 task 2 + 4: the radio screen (the home page) per Main.dc.html
// (phone) and DesktopRadio.dc.html (desktop). One engine instance powers
// this view, the mini player and every future view. The LIVE badge, the
// now-playing card with server-timeline progress, the declaration chips,
// Like + private Dislike (the 30-second lock explained in words), the
// add-to-playlist menu (no <details>), the Radio / My playlist switch,
// QuietState when nothing is on air. The "Report" entry is intentionally
// ABSENT: the report page does not exist yet (the naryad renders it only
// when it exists). Dislikes carry no count anywhere; the like count is
// the public one from /now.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { usePlayer } from "@/components/player/engine/PlayerEngine";
import { QuietState } from "@/components/shell/QuietState";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CommentsThread } from "@/components/comments/comments-thread";

function fmtTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16);
}

export function RadioScreen() {
  const t = useTranslations("player");
  const radioT = useTranslations("radio");
  const { state, actions } = usePlayer();
  const [progress, setProgress] = useState<number | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  // Server-timeline progress, re-read a few times a second (the engine
  // corrects drift on the audio element; this is display-only).
  useEffect(() => {
    // The first read rides a rAF callback, not the effect body (no
    // synchronous setState in an effect); then a slow display tick.
    const tick = (): void => setProgress(actions.progressMs());
    const raf = requestAnimationFrame(tick);
    const id = setInterval(tick, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(id);
    };
  }, [actions]);

  const now = state.now;
  const durationMs = now ? Math.max(1, now.track.durationSec * 1000) : 1;
  const progressPct = progress === null ? 0 : Math.min(100, Math.max(0, (progress / durationMs) * 100));

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      {/* LIVE badge: a word + the shared-timeline note (never colour alone). */}
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-2 rounded-3xl bg-success-bg px-3 py-1 text-xs font-semibold text-success">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
          {radioT("live")}
        </span>
        <span className="text-xs text-muted">{radioT("oneTimeline")}</span>
      </div>

      {state.playbackFailed ? (
        <div role="status" className="rounded-2xl border border-border bg-surface px-6 py-10 text-center">
          <p className="text-sm text-muted">{t("playbackFailed")}</p>
        </div>
      ) : now ? (
        <>
          {/* Now playing card (hero) */}
          <div className="rounded-2xl border border-border bg-surface p-6">
            <p className="text-xs uppercase tracking-widest text-muted">{t("nowPlaying")}</p>
            <h1 className="mt-1 font-display text-3xl font-semibold leading-tight sm:text-4xl">
              {now.track.title}
            </h1>
            {/* The artist name is plain text until the artist profile route exists. */}
            {now.track.artist && <p className="mt-1 text-sm text-muted">{now.track.artist}</p>}

            {/* Declaration chips: word + value, never colour alone. */}
            <div className="mt-3 flex flex-wrap gap-2">
              {now.track.language && <Chip>{radioT("languageChip", { language: now.track.language })}</Chip>}
              {now.track.aiGenerated && <Chip>{radioT("aiChip")}</Chip>}
              {now.track.instrumental && <Chip>{radioT("instrumentalChip")}</Chip>}
            </div>

            {/* Progress from the server timeline. */}
            <div className="mt-5">
              <div
                role="progressbar"
                aria-label={radioT("progress")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progressPct)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
              >
                <div className="h-full rounded-full bg-gold" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="mt-1 flex justify-between text-xs text-muted">
                <span>{progress === null ? "—" : fmtTime(progress)}</span>
                <span>{fmtTime(durationMs)}</span>
              </div>
            </div>

            {/* Big play/pause + reactions. */}
            <div className="mt-6 flex items-center gap-4">
              <button
                type="button"
                onClick={actions.playPause}
                aria-label={state.playing ? t("pause") : t("play")}
                className="focus-gold inline-flex h-16 w-16 items-center justify-center rounded-full bg-gold text-2xl text-background hover:brightness-110"
              >
                <span aria-hidden="true">{state.playing ? t("iconPause") : t("iconPlay")}</span>
                <span className="sr-only">{state.playing ? t("pause") : t("play")}</span>
              </button>

              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={actions.like}
                    aria-pressed={state.reaction === "LIKE"}
                    className="focus-gold inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted hover:text-text aria-pressed:text-gold"
                  >
                    <span aria-hidden="true">{t("iconHeart")}</span>
                    {state.reaction === "LIKE" ? t("liked") : t("like")}
                    <span className="text-muted">{t("likesCount", { count: now.track.likes })}</span>
                  </button>
                  <button
                    type="button"
                    onClick={actions.dislike}
                    aria-pressed={state.reaction === "DISLIKE"}
                    className="focus-gold inline-flex min-h-[44px] items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted hover:text-text aria-pressed:text-muted"
                  >
                    <span aria-hidden="true" className="rotate-180">
                      {t("iconHeartDown")}
                    </span>
                    <span className="sr-only">{t("dislike")}</span>
                    {/* No count, no state for anyone else — the private dislike. */}
                  </button>
                </div>
                {state.likeLocked && <p className="text-xs text-muted">{t("likeLocked")}</p>}
              </div>
            </div>

            {/* Add to playlist: a proper disclosure menu, not <details>. */}
            {state.playing && (
              <div className="mt-5">
                <Button variant="ghost" aria-expanded={addOpen} onClick={() => setAddOpen((v) => !v)}>
                  {t("addToPlaylist")}
                </Button>
                {addOpen && (
                  <ul className="mt-2 space-y-1 rounded-xl border border-border bg-sunken p-2">
                    {state.playlists.length === 0 && <li className="px-2 py-1 text-xs text-muted">{t("noPlaylists")}</li>}
                    {state.playlists.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="focus-gold w-full rounded-lg px-2 py-2 text-left text-sm text-text hover:bg-raised"
                          onClick={() => {
                            void actions.addToPlaylist(p.id).then((ok) => ok && setAddOpen(false));
                          }}
                        >
                          {t("playlistOption", { name: p.name, count: p.itemCount })}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          {/* The playlist tab of the radio screen: picker + queue + prev/next. */}
          {state.mode === "playlist" && (
            <div className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="playlist-pick">
                  {t("playlistPick")}
                </label>
                <select
                  id="playlist-pick"
                  className="focus-gold min-h-[44px] rounded-xl border border-border bg-sunken px-3 text-sm text-text"
                  onChange={(e) => void actions.openQueue(e.target.value)}
                  defaultValue=""
                >
                  <option value="" disabled>
                    {t("playlistPick")}
                  </option>
                  {state.playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.name} (${p.itemCount})`}
                    </option>
                  ))}
                </select>
                <Button variant="secondary" onClick={() => void actions.startPlaylistItem(0)} disabled={state.queue.length === 0}>
                  {t("play")}
                </Button>
                <Button variant="secondary" onClick={() => actions.skipPlaylist(-1)} disabled={state.queueIndex === null || state.queueIndex <= 0}>
                  {t("previous")}
                </Button>
                <Button variant="secondary" onClick={() => actions.skipPlaylist(1)} disabled={state.queueIndex === null || state.queueIndex >= state.queue.length - 1}>
                  {t("next")}
                </Button>
              </div>
              {state.queue.length > 0 && (
                <ol className="mt-3 space-y-1">
                  {state.queue.map((item, i) => (
                    <li key={item.trackId}>
                      <button
                        type="button"
                        onClick={() => void actions.startPlaylistItem(i)}
                        disabled={item.unavailable}
                        className={`focus-gold w-full rounded-lg px-2 py-2 text-left text-sm ${
                          i === state.queueIndex ? "font-semibold text-gold" : "text-text disabled:text-muted"
                        }`}
                      >
                        {item.unavailable ? t("playlistUnavailable") : (item.title ?? "")}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {/* Up next (from the same shared /now body). */}
          {state.upcoming.length > 0 && state.mode === "radio" && (
            <div>
              <h2 className="text-xs uppercase tracking-widest text-muted">{radioT("upNext")}</h2>
              <ol className="mt-2 space-y-1">
                {state.upcoming.slice(0, 3).map((slot) => (
                  <li key={`${slot.track.id}-${slot.startsAt}`} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm">
                    <span className="truncate text-text">{slot.track.title}</span>
                    <span className="ml-3 shrink-0 text-xs text-muted">{fmtClock(slot.startsAt)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* H-303: comments for the track on air — text only, never HTML (S5). */}
          {state.playing && now && state.mode === "radio" && (
            <details className="rounded-2xl border border-border bg-surface p-4">
              <summary className="focus-gold cursor-pointer rounded-lg text-sm text-muted">{radioT("comments")}</summary>
              <div className="mt-3">
                <CommentsThread trackId={now.track.id} />
              </div>
            </details>
          )}
        </>
      ) : (
        <QuietState />
      )}

      {/* The Radio / My playlist switch (the engine owns the mode). */}
      <div className="flex gap-2" role="tablist" aria-label={t("nowPlaying")}>
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === "radio"}
          onClick={() => actions.setMode("radio")}
          className={`focus-gold min-h-[44px] rounded-xl px-4 text-sm font-medium ${state.mode === "radio" ? "bg-raised text-gold" : "text-muted hover:text-text"}`}
        >
          {t("modeRadio")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={state.mode === "playlist"}
          onClick={() => {
            if (state.mode === "playlist") {
              actions.setMode("radio");
            } else {
              actions.setMode("playlist");
              void actions.loadPlaylists();
            }
          }}
          className={`focus-gold min-h-[44px] rounded-xl px-4 text-sm font-medium ${state.mode === "playlist" ? "bg-raised text-gold" : "text-muted hover:text-text"}`}
        >
          {t("modePlaylist")}
        </button>
      </div>
    </div>
  );
}
