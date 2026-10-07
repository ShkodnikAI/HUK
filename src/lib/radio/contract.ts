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
