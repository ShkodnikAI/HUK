// Client-side listening verification (H-301): the player opens a session
// when playback starts, beats every 10 s, and sends the final beat with
// navigator.sendBeacon (survives tab close). Framework-free so the beacon
// contract is unit-testable in node.

export interface ListenClientConfig {
  trackId: string;
  mode: "RADIO" | "PLAYLIST";
  /** Persistent random id for anonymous listeners (stored in localStorage). */
  anonId?: string;
}

/** Opens a session; returns its unguessable id or null when refused. */
export async function startListenSession(
  config: ListenClientConfig,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn("/api/listen/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { sessionId?: string };
    return body.sessionId ?? null;
  } catch {
    return null; // verification is best-effort: never break playback
  }
}

/**
 * The final beat: `navigator.sendBeacon` so it survives pause/navigation/
 * tab close. Returns false when no beacon transport exists (tests inject
 * a mock; the polling beat then covers it).
 */
export function sendFinalBeat(
  sessionId: string,
  beacon: ((url: string, data: BodyInit) => boolean) | null,
): boolean {
  if (!beacon) return false;
  return beacon("/api/listen/beat", JSON.stringify({ sessionId, skipped: true }));
}
