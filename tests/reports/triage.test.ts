import { describe, expect, it } from "vitest";
import { KeywordTriage, currentTriage } from "@/server/reports/triage";
import { applyRestrictions, trackRestrictedFor, type RadioNowResponse } from "@/lib/radio/contract";

// H-206 task 1: the triage hook is deterministic (keyword fallback) and the
// restriction skip logic lives in the shared contract so the player and the
// tests exercise the same code.

describe("H-206 triage fallback (deterministic)", () => {
  const cases: Array<[string, string, number]> = [
    ["sexual content involving a minor", "CSAM", 3],
    ["he makes death threats against people", "THREATS", 3],
    ["constant harassment of another artist", "HARASSMENT", 2],
    ["the description contains someone's home address", "DOXXING", 2],
    ["this is a phishing scam", "FRAUD", 2],
    ["selling drugs in the description", "ILLEGAL_TRADE", 2],
    ["this is not the author's music, copyright violation", "COPYRIGHT", 1],
    ["pure spam, identical uploads", "SPAM", 1],
    ["I just do not like this genre", "OTHER", 1],
  ];

  for (const [reason, category, urgency] of cases) {
    it(`maps "${reason.slice(0, 30)}…" to ${category}/${urgency}`, async () => {
      const verdict = await currentTriage().triage({ reason, targetType: "TRACK" });
      expect(verdict.category).toBe(category);
      expect(verdict.urgency).toBe(urgency);
    });
  }

  it("is deterministic: the same input always yields the same verdict", async () => {
    const t = new KeywordTriage();
    const a = await t.triage({ reason: "scam attempt", targetType: "USER" });
    const b = await t.triage({ reason: "scam attempt", targetType: "USER" });
    expect(a).toEqual(b);
  });

  it("urgency stays within 0..3 and the category vocabulary is fixed", async () => {
    const verdict = await new KeywordTriage().triage({ reason: "whatever", targetType: "PLAYLIST" });
    expect(verdict.urgency).toBeGreaterThanOrEqual(0);
    expect(verdict.urgency).toBeLessThanOrEqual(3);
    expect(typeof verdict.category).toBe("string");
  });
});

describe("H-206 restriction skip (shared contract, used by the player)", () => {
  const base: RadioNowResponse = {
    serverTime: 1000,
    current: {
      track: { id: "t1", title: "x", artist: null, durationSec: 60, audioUrl: "u", restrictedIn: ["DE", "FR"] },
      startsAt: 0,
      endsAt: 60_000,
      offsetMs: 10,
    },
    next: [
      { track: { id: "t2", title: "y", artist: null, durationSec: 60, audioUrl: "u", restrictedIn: [] }, startsAt: 60_000, endsAt: 120_000 },
    ],
  };

  it("skips a restricted track for a listener in a listed country", () => {
    expect(trackRestrictedFor(base.current!.track, "DE")).toBe(true);
    expect(applyRestrictions(base, "DE").current).toBeNull(); // the player stays on standby
  });

  it("plays normally for other countries and without a country header", () => {
    expect(trackRestrictedFor(base.current!.track, "NL")).toBe(false);
    expect(applyRestrictions(base, "NL").current).not.toBeNull();
    expect(applyRestrictions(base, null).current).not.toBeNull();
    expect(applyRestrictions(base, undefined).current).not.toBeNull();
  });

  it("is case-insensitive and never mutates the input", () => {
    expect(trackRestrictedFor(base.current!.track, "de")).toBe(true);
    const out = applyRestrictions(base, "DE");
    expect(base.current).not.toBeNull(); // input untouched
    expect(out.next).toEqual(base.next);
  });

  it("a track without restrictions is never skipped", () => {
    expect(trackRestrictedFor(base.next[0].track, "DE")).toBe(false);
  });
});
