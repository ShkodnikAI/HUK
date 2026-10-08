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
  standbyBackoffMs,
  type ServerSlot,
} from "@/lib/sync/clock";
import {
  isStale,
  registerFailure,
  slotKey,
  watchPlaybackFailures,
  type FailureState,
} from "@/lib/sync/playback";
import { applyRestrictions, type RadioNowResponse } from "@/lib/radio/contract";
import { sendFinalBeat, startListenSession } from "@/lib/listen/client";

// The persistent radio player (H-105): one <audio> element mounted in the
// root locale layout so it survives navigation. Polls /api/radio/now
// adaptively (min(10 s, endsAt − now) while playing; standby backs off
// 2 s → 5 s with jitter), syncs to the server clock (skew), corrects
// drift > 3 s by seeking, re-syncs on visibilitychange/online, retries a
// failing slot at most twice (H-212, G3) and exposes Media Session
// metadata with play/pause (no seek — live radio).

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
  // H-301: server-verified listening + the like button.
  const [slotTrackId, setSlotTrackId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const beatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reactionTrackRef = useRef<string | null>(null);
  const [reaction, setReaction] = useState<"LIKE" | "DISLIKE" | null>(null);
  const [likeLocked, setLikeLocked] = useState(false);
  // H-212 (G3): per-slot retry budget and standby backoff state.
  const failedRef = useRef<FailureState | null>(null);
  const emptyPollsRef = useRef(0);
  const pollNowRef = useRef<() => void>(() => {});
  const [playbackFailed, setPlaybackFailed] = useState(false);

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

    // H-212 (G3): the retry budget is per slot — a different (or absent)
    // slot clears the failure state, the player starts clean.
    const key = current ? slotKey(current.startsAt, current.endsAt) : null;
    if (isStale(failedRef.current, key)) {
      failedRef.current = null;
      setPlaybackFailed(false);
    }

    if (!current) {
      // Nothing scheduled: stay on standby.
      setNowTitle(null);
      audio.pause();
      if (audio.src) audio.removeAttribute("src");
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    emptyPollsRef.current = 0; // a slot is playing again
    setNowTitle(`${current.track.title}${current.track.artist ? ` — ${current.track.artist}` : ""}`);
    if (current.track.id !== reactionTrackRef.current) {
      // H-301: a new track resets the like state (done in this callback, not
      // an effect body, to avoid cascading renders).
      reactionTrackRef.current = current.track.id;
      setReaction(null);
      setLikeLocked(false);
      setSlotTrackId(current.track.id);
    }

    const wanted = new URL(current.track.audioUrl, window.location.origin).toString();
    // A pending retry for THIS slot forces a fresh load attempt even though
    // the URL is unchanged (the element failed once already).
    const retrying = failedRef.current !== null && failedRef.current.key === key;
    if (audio.src !== wanted || retrying) {
      audio.src = wanted;
      audio.currentTime = expectedOffsetMs({ startsAt: current.startsAt, endsAt: current.endsAt }, nowServer) / 1000;
      if (retrying) audio.load();
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

  // Poll loop: adaptive delay from the pure helper; standby (current ===
  // null) backs off 2 s then 5 s with ±20 % jitter; also re-syncs on
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
          const slot = currentRef.current;
          const delay = slot
            ? nextPollDelayMs(nowServer, slot.endsAt)
            : standbyBackoffMs(++emptyPollsRef.current);
          timer = setTimeout(() => void poll(), delay);
          return;
        }
      } catch {
        // network hiccup — retry at the minimum delay
      }
      timer = setTimeout(() => void poll(), 1000);
    };

    // H-212 (G3): playback failures re-poll immediately instead of waiting
    // for the next scheduled poll.
    pollNowRef.current = () => {
      if (timer) clearTimeout(timer);
      void poll();
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

  // H-301: a persistent random id for anonymous verification (hashed with
  // the rotating salt server-side; the raw id never leaves the browser).
  const anonId = useCallback((): string | undefined => {
    try {
      const KEY = "huk-anon-id";
      let v = localStorage.getItem(KEY);
      if (!v) {
        v = crypto.randomUUID().replace(/-/g, "");
        localStorage.setItem(KEY, v);
      }
      return v;
    } catch {
      return undefined; // no storage: anonymous verification unavailable
    }
  }, []);

  // H-301: server-verified listening — one session per track while
  // playing; beats every 10 s; the final beat rides navigator.sendBeacon
  // so pause/tab-close/navigation still closes the session.
  useEffect(() => {
    const beacon = typeof navigator !== "undefined" && "sendBeacon" in navigator ? navigator.sendBeacon.bind(navigator) : null;
    const endSession = (): void => {
      if (beatTimerRef.current) {
        clearInterval(beatTimerRef.current);
        beatTimerRef.current = null;
      }
      if (sessionIdRef.current) {
        sendFinalBeat(sessionIdRef.current, beacon);
        sessionIdRef.current = null;
      }
    };

    if (!playing || !slotTrackId) {
      endSession();
      return;
    }
    let cancelled = false;
    void (async () => {
      const sid = await startListenSession({ trackId: slotTrackId, mode: "RADIO", anonId: anonId() });
      if (!sid || cancelled || sessionIdRef.current) return;
      sessionIdRef.current = sid;
      beatTimerRef.current = setInterval(() => {
        const id = sessionIdRef.current;
        if (!id) return;
        void fetch("/api/listen/beat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: id, anonId: anonId() }),
        }).catch(() => {}); // verification is best-effort, never breaks playback
      }, 10_000);
    })();
    return () => {
      cancelled = true;
      endSession();
    };
  }, [playing, slotTrackId, anonId]);

  // H-301: the caller's own reaction state for the current track (fetched
  // once per track; the reset on a track change happens in applyTimeline).
  useEffect(() => {
    if (!slotTrackId || reactionTrackRef.current !== slotTrackId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/me/reactions?trackIds=${encodeURIComponent(slotTrackId)}`, { cache: "no-store" });
        if (!res.ok) return; // anonymous: no own state to show
        const body = (await res.json()) as { reactions?: Array<{ trackId: string; type: "LIKE" | "DISLIKE" }> };
        if (!cancelled && body.reactions && body.reactions.length > 0) setReaction(body.reactions[0].type);
      } catch {
        /* offline: the button still works */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slotTrackId]);

  const onLike = useCallback((): void => {
    const trackId = slotTrackId;
    if (!trackId) return;
    void (async () => {
      try {
        if (reaction === "LIKE") {
          const res = await fetch(`/api/reactions/${encodeURIComponent(trackId)}`, { method: "DELETE" });
          if (res.ok) setReaction(null);
          return;
        }
        const res = await fetch("/api/reactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackId, type: "LIKE" }),
        });
        if (res.ok) {
          setReaction("LIKE");
          setLikeLocked(false);
        } else if (res.status === 403) {
          setLikeLocked(true); // the 30 s verification gate
        }
      } catch {
        /* offline: keep the current state */
      }
    })();
  }, [slotTrackId, reaction]);

  // H-212 (G3): audio error / stall > 10 s re-polls /now immediately; the
  // same slot is retried at most twice, then the failure state is shown
  // until the next slot (the policy itself lives in lib/sync/playback.ts).
  const handleFailure = useCallback((): void => {
    const slot = currentRef.current;
    if (!slot) return; // nothing playing — the poll loop owns standby
    const key = slotKey(slot.startsAt, slot.endsAt);
    const next = registerFailure(failedRef.current, key);
    failedRef.current = next;
    if (next.giveUp) {
      setPlaybackFailed(true); // clear state until the slot changes
      return;
    }
    pollNowRef.current();
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    return watchPlaybackFailures(audio, handleFailure);
  }, [handleFailure]);

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
        <span className="text-sm text-neutral-300">
          {playbackFailed ? t("playbackFailed") : (nowTitle ?? t("standby"))}
        </span>
        {slotTrackId && playing && (
          <button
            type="button"
            onClick={onLike}
            aria-pressed={reaction === "LIKE"}
            title={likeLocked ? t("likeLocked") : undefined}
            className={`ml-auto rounded-full border px-3 py-1 text-sm ${reaction === "LIKE" ? "border-[#D4AF37] text-[#D4AF37]" : "text-neutral-300"}`}
          >
            {reaction === "LIKE" ? t("liked") : t("like")}
          </button>
        )}
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
