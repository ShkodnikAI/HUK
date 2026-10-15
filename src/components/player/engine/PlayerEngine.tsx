"use client";

// The radio ENGINE (H-121 task 1): one <audio> element mounted ONCE in the
// locale layout, all playback behaviour lives here, and views (the radio
// screen, the mini player) read the typed usePlayer() hook. A refactor
// first: the behaviour is moved verbatim from the former radio-player.tsx
// (poll /api/radio/now adaptively, server-clock skew, drift correction,
// geo restrictions, listen heartbeat, per-slot retry budget, Media
// Session, playlist on-demand playback). New in H-121: the private
// DISLIKE action (never a count, never anyone else's state) and the
// now-playing metadata the radio screen needs (likes, language,
// instrumental, aiGenerated).

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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
import { applyRestrictions, type RadioNowResponse, type RadioNowTrack } from "@/lib/radio/contract";
import { sendFinalBeat, startListenSession } from "@/lib/listen/client";

export type PlayerMode = "radio" | "playlist";

export type QueueItem = { trackId: string; title: string | null; unavailable: boolean; audioUrl: string };

export type PlaylistSummary = { id: string; name: string; itemCount: number };

export type NowPlaying = {
  track: RadioNowTrack;
  startsAt: number;
  endsAt: number;
  /** Server-timeline offset of the listener (ms into the slot). */
  offsetMs: number;
};

export type PlayerState = {
  mode: PlayerMode;
  playing: boolean;
  /** The current slot AFTER geo restrictions (null = standby). */
  now: NowPlaying | null;
  /** The timeline as /now returned it (before geo filtering) — upcoming slots. */
  upcoming: RadioNowResponse["next"];
  playbackFailed: boolean;
  /** Own reaction state for the current track (never anyone else's). */
  reaction: "LIKE" | "DISLIKE" | null;
  likeLocked: boolean;
  playlists: PlaylistSummary[];
  queue: QueueItem[];
  queueIndex: number | null;
};

export type PlayerActions = {
  playPause: () => void;
  setMode: (mode: PlayerMode) => void;
  like: () => void;
  /** Private dislike — no count exists anywhere, for anyone (H-121). */
  dislike: () => void;
  refreshOwnReactions: () => void;
  loadPlaylists: () => Promise<void>;
  openQueue: (playlistId: string) => Promise<void>;
  startPlaylistItem: (index: number) => Promise<void>;
  skipPlaylist: (delta: number) => void;
  addToPlaylist: (playlistId: string) => Promise<boolean>;
  /** Server-timeline progress of the current slot (ms), or null on standby. */
  progressMs: () => number | null;
  /** The skew-corrected server clock (ms). */
  serverNowMs: () => number;
};

const PlayerContext = createContext<{ state: PlayerState; actions: PlayerActions } | null>(null);

export function usePlayer(): { state: PlayerState; actions: PlayerActions } {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside <PlayerProvider>");
  return ctx;
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const skewRef = useRef(0);
  const currentRef = useRef<ServerSlot | null>(null);
  const countryRef = useRef<string | null | undefined>(undefined);
  const [mode, setMode] = useState<PlayerMode>("radio");
  const modeRef = useRef<PlayerMode>("radio");
  const [playing, setPlaying] = useState(false);
  const [now, setNow] = useState<NowPlaying | null>(null);
  const [upcoming, setUpcoming] = useState<RadioNowResponse["next"]>([]);
  const stoppedRef = useRef(false);
  // H-301: server-verified listening + the reaction buttons.
  const [slotTrackId, setSlotTrackId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const beatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reactionTrackRef = useRef<string | null>(null);
  const [reaction, setReaction] = useState<"LIKE" | "DISLIKE" | null>(null);
  const [likeLocked, setLikeLocked] = useState(false);
  // H-302: the playlist playback mode.
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueIndex, setQueueIndex] = useState<number | null>(null);
  // H-212 (G3): per-slot retry budget and standby backoff state.
  const failedRef = useRef<FailureState | null>(null);
  const emptyPollsRef = useRef(0);
  const pollNowRef = useRef<() => void>(() => {});
  const [playbackFailed, setPlaybackFailed] = useState(false);
  // H-121: the playing flag is read inside applyTimeline (verbatim move) —
  // a ref keeps the callback stable for the poll loop (synced in an effect:
  // refs are not touched during render).
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // H-302: switching modes toggles who owns the audio element; leaving the
  // playlist mode stops on-demand playback.
  const switchMode = useCallback((next: PlayerMode): void => {
    modeRef.current = next;
    if (next === "radio") {
      if (sessionIdRef.current) {
        sessionIdRef.current = null;
      }
      setQueueIndex(null);
      setQueue([]);
    }
    setMode(next);
  }, []);

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
    setUpcoming(effective.next);
    setNow(
      current
        ? {
            track: current.track,
            startsAt: current.startsAt,
            endsAt: current.endsAt,
            offsetMs: current.offsetMs,
          }
        : null,
    );

    if (modeRef.current === "playlist") {
      // H-302: on-demand playback owns the audio element; the radio
      // timeline is only kept fresh in the background.
      return;
    }

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
      audio.pause();
      if (audio.src) audio.removeAttribute("src");
      if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
      return;
    }

    emptyPollsRef.current = 0; // a slot is playing again
    if (current.track.id !== reactionTrackRef.current) {
      // H-301: a new track resets the reaction state (done in this callback,
      // not an effect body, to avoid cascading renders).
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
      if (playingRef.current) void audio.play().catch(() => {});
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
  }, []);

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
      const sid = await startListenSession({ trackId: slotTrackId, mode: modeRef.current === "playlist" ? "PLAYLIST" : "RADIO", anonId: anonId() });
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
  const refreshOwnReactions = useCallback((): void => {
    const trackId = reactionTrackRef.current;
    if (!trackId) return;
    void (async () => {
      try {
        const res = await fetch(`/api/me/reactions?trackIds=${encodeURIComponent(trackId)}`, { cache: "no-store" });
        if (!res.ok) return; // anonymous: no own state to show
        const body = (await res.json()) as { reactions?: Array<{ trackId: string; type: "LIKE" | "DISLIKE" }> };
        if (body.reactions && body.reactions.length > 0) setReaction(body.reactions[0].type);
      } catch {
        /* offline: the button still works */
      }
    })();
  }, []);

  useEffect(() => {
    if (!slotTrackId || reactionTrackRef.current !== slotTrackId) return;
    refreshOwnReactions();
  }, [slotTrackId, refreshOwnReactions]);

  // H-302: playlist mode — queue, next/previous, seek allowed.
  const loadPlaylists = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/playlists", { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { playlists?: PlaylistSummary[] };
        setPlaylists(body.playlists ?? []);
      }
    } catch {
      /* offline: the picker stays empty */
    }
  }, []);

  const openQueue = useCallback(async (playlistId: string): Promise<void> => {
    try {
      const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as {
        items?: Array<{ trackId: string; unavailable: boolean; title?: string; audioUrl?: string }>;
      };
      const items = (body.items ?? []).map((i) => ({
        trackId: i.trackId,
        title: i.unavailable ? null : (i.title ?? null),
        unavailable: i.unavailable,
        audioUrl: i.audioUrl ?? "",
      }));
      setQueue(items);
      setQueueIndex(null);
    } catch {
      /* offline */
    }
  }, []);

  const startPlaylistItem = useCallback(
    async (index: number): Promise<void> => {
      const item = queue[index];
      const audio = audioRef.current;
      if (!item || item.unavailable || !audio) return;
      const sid = await startListenSession({ trackId: item.trackId, mode: "PLAYLIST", anonId: anonId() });
      sessionIdRef.current = sid; // PLAYLIST sessions feed the same verification gate
      audio.src = new URL(item.audioUrl, window.location.origin).toString();
      audio.currentTime = 0;
      setQueueIndex(index);
      void audio.play().then(() => setPlaying(true)).catch(() => {});
    },
    [queue, anonId],
  );

  const skipPlaylist = useCallback(
    (delta: number): void => {
      if (queueIndex === null) return;
      const next = queueIndex + delta;
      if (next < 0 || next >= queue.length) return;
      void startPlaylistItem(next);
    },
    [queueIndex, queue.length, startPlaylistItem],
  );

  const addToPlaylist = useCallback(
    async (playlistId: string): Promise<boolean> => {
      const trackId = slotTrackId;
      if (!trackId) return false;
      try {
        const res = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/items`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackId }),
        });
        return res.ok;
      } catch {
        return false; // offline
      }
    },
    [slotTrackId],
  );

  const react = useCallback(
    (type: "LIKE" | "DISLIKE"): void => {
      const trackId = slotTrackId;
      if (!trackId) return;
      void (async () => {
        try {
          if (reaction === type) {
            const res = await fetch(`/api/reactions/${encodeURIComponent(trackId)}`, { method: "DELETE" });
            if (res.ok) setReaction(null);
            return;
          }
          const res = await fetch("/api/reactions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ trackId, type }),
          });
          if (res.ok) {
            setReaction(type);
            if (type === "LIKE") setLikeLocked(false);
          } else if (res.status === 403) {
            setLikeLocked(true); // the 30 s verification gate
          }
        } catch {
          /* offline: keep the current state */
        }
      })();
    },
    [slotTrackId, reaction],
  );

  const like = useCallback((): void => react("LIKE"), [react]);
  // H-121: the private dislike — no count, no public state, anywhere.
  const dislike = useCallback((): void => react("DISLIKE"), [react]);

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

  const playPause = useCallback((): void => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      const slot = currentRef.current;
      if (slot && modeRef.current === "radio") {
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
  }, []);

  const progressMs = useCallback((): number | null => {
    const slot = currentRef.current;
    if (!slot) return null;
    return expectedOffsetMs(slot, serverNow(Date.now(), skewRef.current));
  }, []);

  const serverNowMs = useCallback((): number => serverNow(Date.now(), skewRef.current), []);

  const state: PlayerState = {
    mode,
    playing,
    now,
    upcoming,
    playbackFailed,
    reaction,
    likeLocked,
    playlists,
    queue,
    queueIndex,
  };
  const actions: PlayerActions = {
    playPause,
    setMode: switchMode,
    like,
    dislike,
    refreshOwnReactions,
    loadPlaylists,
    openQueue,
    startPlaylistItem,
    skipPlaylist,
    addToPlaylist,
    progressMs,
    serverNowMs,
  };

  return (
    <PlayerContext.Provider value={{ state, actions }}>
      {children}
      {/* The ONE audio element — mounted once, survives every navigation. */}
      <audio ref={audioRef} preload="none" />
    </PlayerContext.Provider>
  );
}
