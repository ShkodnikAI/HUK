"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  computeSkew,
  expectedOffsetMs,
  needsDriftCorrection,
  nextPollDelayMs,
  serverNow,
  shouldResyncOnOnline,
  shouldResyncOnVisibility,
  type ServerSlot,
} from "@/lib/sync/clock";
import { applyRestrictions, type RadioNowResponse } from "@/lib/radio/contract";

// The persistent radio player (H-105): one <audio> element mounted in the
// root locale layout so it survives navigation. Polls /api/radio/now
// adaptively (min(30 s, endsAt − now)), syncs to the server clock (skew),
// corrects drift > 3 s by seeking, re-syncs on visibilitychange/online and
// exposes Media Session metadata with play/pause (no seek — live radio).

type Mode = "radio" | "playlist";

interface NowState {
  current: (RadioNowResponse["current"] & { track: { audioUrl: string } }) | null;
  next: RadioNowResponse["next"];
}

export function RadioPlayer() {
  const t = useTranslations("player");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const skewRef = useRef(0);
  const currentRef = useRef<ServerSlot | null>(null);
  const countryRef = useRef<string | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("radio");
  const [playing, setPlaying] = useState(false);
  const [nowTitle, setNowTitle] = useState<string | null>(null);
  const stoppedRef = useRef(false);

  // H-206: the listener's country is fetched once (uncached /api/geo) and
  // combined with the shared /now body client-side — the timeline stays
  // identical for everyone (cache-safe) and the skip is per listener.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/geo", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ country: string | null }>) : { country: null }))
      .then((geo) => {
        if (!cancelled) countryRef.current = geo.country;
      })
      .catch(() => {
        if (!cancelled) countryRef.current = null; // header absent → never skip
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyTimeline = useCallback((data: RadioNowResponse) => {
    skewRef.current = computeSkew(data.serverTime, Date.now());
    const nowServer = serverNow(Date.now(), skewRef.current);
    // H-206: a track restricted for this listener's country is skipped —
    // standby instead of playback, polling continues.
    const effective = applyRestrictions(data, countryRef.current);
    const current = effective.current;
    currentRef.current = current ? { startsAt: current.startsAt, endsAt: current.endsAt } : null;

    const audio = audioRef.current;
    if (!audio) return;

    if (!current) {
      // Nothing scheduled: stay on standby.
      setNowTitle(null);
      audio.pause();
      if (audio.src) audio.removeAttribute("src");
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    setNowTitle(`${current.track.title}${current.track.artist ? ` — ${current.track.artist}` : ""}`);

    const wanted = new URL(current.track.audioUrl, window.location.origin).toString();
    if (audio.src !== wanted) {
      audio.src = wanted;
      audio.currentTime = expectedOffsetMs({ startsAt: current.startsAt, endsAt: current.endsAt }, nowServer) / 1000;
      if (playing) void audio.play().catch(() => {});
    }

    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.track.title,
        artist: current.track.artist ?? "",
        artwork: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    }
  }, [playing]);

  // Poll loop: adaptive delay from the pure helper; also re-syncs on
  // visibilitychange and online.
  useEffect(() => {
    stoppedRef.current = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async (): Promise<void> => {
      if (stoppedRef.current) return;
      try {
        const res = await fetch("/api/radio/now", { cache: "no-store" });
        if (res.ok) {
          const data = (await res.json()) as RadioNowResponse;
          applyTimeline(data);
          const nowServer = serverNow(Date.now(), skewRef.current);
          const delay = nextPollDelayMs(
            nowServer,
            currentRef.current ? currentRef.current.endsAt : null,
          );
          timer = setTimeout(() => void poll(), delay);
          return;
        }
      } catch {
        // network hiccup — retry at the minimum delay
      }
      timer = setTimeout(() => void poll(), 1000);
    };

    const onVisibility = (): void => {
      if (shouldResyncOnVisibility(document.visibilityState as "visible" | "hidden")) {
        void poll();
      }
    };
    const onOnline = (): void => {
      if (shouldResyncOnOnline(navigator.onLine)) void poll();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    void poll();

    return () => {
      stoppedRef.current = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [applyTimeline]);

  // Drift correction: several times a second, seek when |drift| > 3 s.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = (): void => {
      const slot = currentRef.current;
      if (!slot) return;
      const nowServer = serverNow(Date.now(), skewRef.current);
      const expected = expectedOffsetMs(slot, nowServer);
      const actual = audio.currentTime * 1000;
      if (needsDriftCorrection(expected, actual)) {
        audio.currentTime = expected / 1000;
      }
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => audio.removeEventListener("timeupdate", onTimeUpdate);
  }, []);

  // Media Session: metadata set per track; play/pause only — no seek (live).
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => void audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    return () => {
      if (!("mediaSession" in navigator)) return;
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
    };
  }, []);

  const onPlayPause = (): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      const slot = currentRef.current;
      if (slot) {
        const expected = expectedOffsetMs(slot, serverNow(Date.now(), skewRef.current));
        if (needsDriftCorrection(expected, audio.currentTime * 1000)) {
          audio.currentTime = expected / 1000;
        }
      }
      void audio.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  return (
    <section aria-label={t("nowPlaying")} className="w-full">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onPlayPause} className="rounded-full border px-4 py-2">
          {playing ? t("pause") : t("play")}
        </button>
        <span className="text-sm text-neutral-300">{nowTitle ?? t("standby")}</span>
      </div>
      <div className="mt-3 flex gap-2 text-sm" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "radio"}
          onClick={() => setMode("radio")}
          className={mode === "radio" ? "font-semibold text-[#D4AF37]" : "text-neutral-400"}
        >
          {t("modeRadio")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "playlist"}
          disabled
          title={t("comingSoon")}
          className="text-neutral-600"
        >
          {t("modePlaylistStub")}
        </button>
      </div>
      <audio ref={audioRef} preload="none" />
    </section>
  );
}
