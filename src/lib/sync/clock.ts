// Pure sync math for the radio player (H-105). No DOM, no clock — the
// current time is always a parameter, so everything is unit-testable with a
// fake clock. All values are milliseconds unless noted.

/** Drift beyond this threshold triggers a seek back to the expected offset. */
export const DRIFT_CORRECTION_MS = 3000;
/** The player never polls more rarely than this. */
export const MAX_POLL_INTERVAL_MS = 30_000;
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
 * Delay until the next `/api/radio/now` poll: `min(30 s, endsAt − now)` with
 * a small buffer past the slot end, floored at 1 s. `null` endsAt (nothing
 * playing) polls at the minimum so the player recovers quickly.
 */
export function nextPollDelayMs(
  nowServer: number,
  currentEndsAt: number | null,
  maxMs: number = MAX_POLL_INTERVAL_MS,
): number {
  if (currentEndsAt === null) return MIN_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.min(maxMs, currentEndsAt - nowServer + 250));
}

/** Re-sync policy: fetch immediately when the tab becomes visible again. */
export function shouldResyncOnVisibility(visibility: "visible" | "hidden"): boolean {
  return visibility === "visible";
}

/** Re-sync policy: fetch immediately when connectivity returns. */
export function shouldResyncOnOnline(online: boolean): boolean {
  return online;
}
