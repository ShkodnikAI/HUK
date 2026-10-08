// Playback failure policy for the radio player (H-212, finding G3).
// Framework-free on purpose: the component wires the DOM events, this module
// owns the DECISIONS, so the rules are unit-testable with an audio mock and
// fake timers (vitest environment is node — no DOM).
//
// - a hard failure (`error`) or a stall (`waiting`/`stalled`) longer than
//   STALL_REPOLL_MS triggers an immediate re-poll of /api/radio/now;
// - the same slot is retried at most MAX_PLAYBACK_RETRIES times; then the
//   player shows the failure state and waits for the next slot (never a
//   spin loop);
// - the retry budget is per slot: a new slot starts clean.

/** How many times the same slot may be retried before the player gives up
 * and shows the failure state until the slot changes (H-212: at most 2). */
export const MAX_PLAYBACK_RETRIES = 2;

/** `waiting`/`stalled` longer than this counts as a playback failure. */
export const STALL_REPOLL_MS = 10_000;

/** Stable identity of the slot a failure belongs to. */
export function slotKey(startsAt: number, endsAt: number): string {
  return `${startsAt}:${endsAt}`;
}

export interface FailureState {
  key: string;
  /** Retries already used for this slot. */
  retries: number;
}

/**
 * Records one failure for the slot `key`. Returns `giveUp` when the retry
 * budget is exhausted — the caller shows the failure state and stops
 * re-polling until the slot changes; otherwise `retries` is incremented and
 * the caller re-polls immediately.
 */
export function registerFailure(
  prev: FailureState | null,
  key: string,
): FailureState & { giveUp: boolean } {
  const retries = prev && prev.key === key ? prev.retries : 0;
  if (retries >= MAX_PLAYBACK_RETRIES) return { key, retries, giveUp: true };
  return { key, retries: retries + 1, giveUp: false };
}

/** The failure state is obsolete once a different (or no) slot is current. */
export function isStale(state: FailureState | null, key: string | null): boolean {
  return state !== null && state.key !== key;
}

/** Minimal DOM surface the watcher needs (HTMLMediaElement subset). */
export interface AudioLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** Injectable clock/timers so the watcher is testable with fake timers. */
export interface WatcherTimers {
  now(): number;
  set(handler: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: WatcherTimers = {
  now: () => Date.now(),
  set: (handler, ms) => setInterval(handler, ms),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/**
 * Attaches `error` / `stalled` / `waiting` / `playing` / `timeupdate`
 * listeners plus a 1 s watchdog. Any hard failure, or a stall longer than
 * STALL_REPOLL_MS, invokes `onFailure` exactly once per incident. Returns a
 * detach function (component cleanup).
 */
export function watchPlaybackFailures(
  audio: AudioLike,
  onFailure: () => void,
  timers: WatcherTimers = defaultTimers,
): () => void {
  let waitingSince: number | null = null;

  const onProgress = (): void => {
    waitingSince = null; // playback progresses again — stall over
  };

  const onStalled = (): void => {
    if (waitingSince === null) waitingSince = timers.now();
  };

  const onError = (): void => {
    waitingSince = null;
    onFailure(); // hard failure → immediate re-poll decision
  };

  const watchdog = (): void => {
    if (waitingSince !== null && timers.now() - waitingSince >= STALL_REPOLL_MS) {
      waitingSince = null; // one signal per incident — never a spin loop
      onFailure();
    }
  };

  audio.addEventListener("error", onError);
  audio.addEventListener("stalled", onStalled);
  audio.addEventListener("waiting", onStalled);
  audio.addEventListener("playing", onProgress);
  audio.addEventListener("timeupdate", onProgress);
  const handle = timers.set(watchdog, 1_000);

  return () => {
    audio.removeEventListener("error", onError);
    audio.removeEventListener("stalled", onStalled);
    audio.removeEventListener("waiting", onStalled);
    audio.removeEventListener("playing", onProgress);
    audio.removeEventListener("timeupdate", onProgress);
    timers.clear(handle);
  };
}
