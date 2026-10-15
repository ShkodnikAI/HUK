"use client";

// H-121: the persistent MINI player — a view over the engine (which lives
// in the layout's PlayerProvider and never remounts). Compact bar: play/
// pause and what is on air. The full radio screen (the home page) shares
// the same engine instance.

import { useTranslations } from "next-intl";
import { usePlayer } from "@/components/player/engine/PlayerEngine";

export function MiniPlayer() {
  const t = useTranslations("player");
  const { state, actions } = usePlayer();
  const title = state.now ? `${state.now.track.title}${state.now.track.artist ? ` — ${state.now.track.artist}` : ""}` : null;

  return (
    <section
      aria-label={t("nowPlaying")}
      className="focus-gold mx-auto flex max-w-[1100px] items-center gap-3 rounded-xl border border-border bg-surface px-4 py-2"
    >
      <button
        type="button"
        onClick={actions.playPause}
        aria-label={state.playing ? t("pause") : t("play")}
        className="focus-gold inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold text-background"
      >
        {/* icon + word (never colour alone) */}
        <span aria-hidden="true">{state.playing ? t("iconPause") : t("iconPlay")}</span>
        <span className="sr-only">{state.playing ? t("pause") : t("play")}</span>
      </button>
      <span className="min-w-0 truncate text-sm text-text">
        {state.playbackFailed ? t("playbackFailed") : (title ?? t("standby"))}
      </span>
    </section>
  );
}
