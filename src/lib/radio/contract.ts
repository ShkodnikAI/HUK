// Shared radio contract (H-104): the shape of `GET /api/radio/now`, used by
// both the API route and (later, H-105) the player client. Epoch values are
// milliseconds since the Unix epoch, so the client can compute skew with
// Date.now() directly (ARCHITECTURE §5).

export type PoolName = "top" | "fresh" | "rest";

export interface RadioNowTrack {
  id: string;
  title: string;
  /** Artist display name, or null for station/seed tracks without an artist. */
  artist: string | null;
  durationSec: number;
  /** Public playback URL (never a signed/internal URL, never moderation data). */
  audioUrl: string;
  /**
   * H-206: countries where HUK must stop presenting this track (ISO
   * 3166-1 alpha-2). The /now body is IDENTICAL for every listener
   * (cache-safe); the player combines it with GET /api/geo client-side.
   */
  restrictedIn: string[];
}

export interface RadioNowSlot {
  track: RadioNowTrack;
  startsAt: number;
  endsAt: number;
}

export interface RadioNowResponse {
  serverTime: number;
  current: (RadioNowSlot & { offsetMs: number }) | null;
  next: RadioNowSlot[];
}

/**
 * H-206: true when the track must not be presented to a listener in
 * `country` (null country — header absent — never skips anything).
 * Comparison is case-insensitive on purpose: the edge header and the
 * moderator input are both normalised, but the contract stays honest.
 */
export function trackRestrictedFor(
  track: Pick<RadioNowTrack, "restrictedIn">,
  country: string | null | undefined,
): boolean {
  if (!country) return false;
  const c = country.toUpperCase();
  return track.restrictedIn.some((code) => code.toUpperCase() === c);
}

/**
 * H-206 player helper: returns the timeline unchanged except that the
 * current slot is dropped when it is restricted for the listener's
 * country — the player then stays on standby (a skipped track, not an
 * error) and keeps polling.
 */
export function applyRestrictions(
  data: RadioNowResponse,
  country: string | null | undefined,
): RadioNowResponse {
  if (data.current && trackRestrictedFor(data.current.track, country)) {
    return { ...data, current: null };
  }
  return data;
}
