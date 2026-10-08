// Pure sync math for the radio player (H-105). No DOM, no clock — the
// current time is always a parameter, so everything is unit-testable with a
// fake clock. All values are milliseconds unless noted.

/** Drift beyond this threshold triggers a seek back to the expected offset. */
export const DRIFT_CORRECTION_MS = 3000;
/** The player never polls more rarely than this while playing (H-212: G3 —
 * a takedown reaches a playing listener within this window). */
export const MAX_POLL_INTERVAL_MS = 10_000;
/** The player never polls more often than this (server/cache courtesy). */
export const MIN_POLL_INTERVAL_MS = 1_000;

/** A slot of the broadcast timeline in server-clock epoch ms. */
export interface ServerSlot {
  startsAt: number;
  endsAt: number;
}

/** skew = serverClock − clientClock: add it to Date.now() to get server time. */
export function computeSkew(serverTime: number, clientNow: number): number {
  return serverTime - clientNow;
}

/** The server's idea of "now" given the client clock and the measured skew. */
export function serverNow(clientNow: number, skew: number): number {
  return clientNow + skew;
}

/**
 * Where playback should be inside the slot right now, in ms from the slot
 * start — clamped into [0, slot duration].
 */
export function expectedOffsetMs(slot: ServerSlot, nowServer: number): number {
  const duration = slot.endsAt - slot.startsAt;
  return Math.max(0, Math.min(nowServer - slot.startsAt, duration));
}

/** True when the audio element's position drifted too far from the timeline. */
export function needsDriftCorrection(
  expectedMs: number,
  actualMs: number,
  toleranceMs: number = DRIFT_CORRECTION_MS,
): boolean {
  return Math.abs(expectedMs - actualMs) > toleranceMs;
}

/**
 * Delay until the next `/api/radio/now` poll while a slot is playing:
 * `min(10 s, endsAt − now)` with a small buffer past the slot end, floored
 * at 1 s. Standby (no current slot) uses `standbyBackoffMs` instead.
 */
export function nextPollDelayMs(
  nowServer: number,
  currentEndsAt: number,
  maxMs: number = MAX_POLL_INTERVAL_MS,
): number {
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(maxMs, currentEndsAt - nowServer + 250));
}

/** H-212 (G3): standby backoff when `current === null` — 2 s after the first
 * empty poll, 5 s afterwards, each with ±20 % jitter so clients don't sync
 * into a poll stampede. */
export const STANDBY_FIRST_MS = 2_000;
export const STANDBY_NEXT_MS = 5_000;
export const STANDBY_JITTER = 0.2;

export function standbyBackoffMs(
  consecutiveEmptyPolls: number,
  rng: () => number = Math.random,
): number {
  const base = consecutiveEmptyPolls <= 1 ? STANDBY_FIRST_MS : STANDBY_NEXT_MS;
  const jitter = 1 + (rng() * 2 - 1) * STANDBY_JITTER;
  return Math.round(base * jitter);
}

/** Re-sync policy: fetch immediately when the tab becomes visible again. */
export function shouldResyncOnVisibility(visibility: "visible" | "hidden"): boolean {
  return visibility === "visible";
}

/** Re-sync policy: fetch immediately when connectivity returns. */
export function shouldResyncOnOnline(online: boolean): boolean {
  return online;
}
