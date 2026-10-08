import { describe, expect, it } from "vitest";
import { sendFinalBeat, startListenSession } from "@/lib/listen/client";

// H-301: the beacon contract — the final beat carries { sessionId, skipped:
// true } to /api/listen/beat via the injected transport, and session start
// degrades to null on any refusal (verification is best-effort).

describe("sendFinalBeat (H-301)", () => {
  it("beacons { sessionId, skipped: true } to /api/listen/beat", () => {
    const calls: Array<{ url: string; data: string }> = [];
    const beacon = (url: string, data: BodyInit): boolean => {
      calls.push({ url, data: String(data) });
      return true;
    };
    expect(sendFinalBeat("session-1", beacon)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/listen/beat");
    expect(JSON.parse(calls[0].data)).toEqual({ sessionId: "session-1", skipped: true });
  });

  it("returns false when no beacon transport exists (caller falls back to the poll loop)", () => {
    expect(sendFinalBeat("session-1", null)).toBe(false);
  });
});

describe("startListenSession (H-301)", () => {
  it("returns the session id on 201", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ sessionId: "s-42" }), { status: 201 })) as unknown as typeof fetch;
    expect(await startListenSession({ trackId: "t", mode: "RADIO" }, fetchFn)).toBe("s-42");
  });

  it("degrades to null on a non-2xx or a network failure (never breaks playback)", async () => {
    const refuse = (async () => new Response("no", { status: 409 })) as unknown as typeof fetch;
    expect(await startListenSession({ trackId: "t", mode: "RADIO" }, refuse)).toBeNull();
    const fail = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await startListenSession({ trackId: "t", mode: "RADIO" }, fail)).toBeNull();
  });
});
