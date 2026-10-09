// H-305 static checks: category-key parsing against the H-402 vocabulary,
// the per-track category derivation, the Monday week-start math, and the
// figures contract — every number the "How charts work" page renders is
// compared with src/server/ranking/signals.ts exactly. No DB involved.

import { describe, expect, it } from "vitest";
import {
  categoryKeysForTrack,
  parseCategoryKey,
  PUBLISHED_MIN_TRACKS,
} from "@/server/charts/categories";
import { howChartsFigures } from "@/server/charts/figures";
import { CHART_LIMIT, utcWeekStart } from "@/server/charts/service";
import {
  HALF_LIFE_MS,
  MIN_VOTERS,
  SIGNAL_WEIGHTS,
  WILSON_Z,
} from "@/server/ranking/signals";
import { VERIFIED_FOR_REACTION_MS } from "@/server/listen/session";
import { FRESH_POOL_SIZE } from "@/server/broadcast/scheduler";

describe("chart category keys (H-305)", () => {
  it("derives the category set from language, instrumental and confirmed terms", () => {
    expect(
      categoryKeysForTrack({ language: "pt-BR", instrumental: false, terms: [{ kind: "STYLE", slug: "synthwave" }, { kind: "DIRECTION", slug: "electronic" }] }),
    ).toEqual(["all", "lang:pt", "style:synthwave", "direction:electronic", "lang:pt+style:synthwave"]);
    expect(categoryKeysForTrack({ language: null, instrumental: true, terms: [] })).toEqual(["all", "instrumental"]);
    // An unlisted language maps to other; a track without terms stays in all only.
    expect(categoryKeysForTrack({ language: "zza", instrumental: false, terms: [] })).toEqual(["all", "lang:other"]);
    expect(categoryKeysForTrack({ language: "en", instrumental: false, terms: [] })).toEqual(["all", "lang:en"]);
  });

  it("parses known keys and rejects unknown slugs and malformed shapes", () => {
    expect(parseCategoryKey("all")).toEqual({ kind: "all" });
    expect(parseCategoryKey("instrumental")).toEqual({ kind: "instrumental" });
    expect(parseCategoryKey("lang:en")).toEqual({ kind: "language", slug: "en" });
    expect(parseCategoryKey("style:drum-and-bass")).toEqual({ kind: "style", slug: "drum-and-bass" });
    expect(parseCategoryKey("direction:folk-world")).toEqual({ kind: "direction", slug: "folk-world" });
    expect(parseCategoryKey("lang:en+style:punk")).toEqual({ kind: "lang+style", lang: "en", style: "punk" });

    expect(parseCategoryKey("lang:xx")).toBeNull(); // not in the vocabulary
    expect(parseCategoryKey("style:discovery")).toBeNull();
    expect(parseCategoryKey("genre:rock")).toBeNull();
    expect(parseCategoryKey("lang:en+direction:rock")).toBeNull();
    expect(parseCategoryKey("lang:en+style:punk+extra")).toBeNull();
    expect(parseCategoryKey("")).toBeNull();
  });

  it("computes the Monday 00:00 UTC week start across the week", () => {
    expect(utcWeekStart(new Date("2026-10-10T18:44:00Z")).toISOString()).toBe("2026-10-05T00:00:00.000Z"); // Saturday → Monday
    expect(utcWeekStart(new Date("2026-10-05T00:00:00Z")).toISOString()).toBe("2026-10-05T00:00:00.000Z"); // Monday itself
    expect(utcWeekStart(new Date("2026-10-04T23:59:59Z")).toISOString()).toBe("2026-09-28T00:00:00.000Z"); // Sunday → previous Monday
  });
});

describe("how-charts figures match the ranking constants (H-305)", () => {
  const f = howChartsFigures();

  it("reads every signal weight from SIGNAL_WEIGHTS", () => {
    expect(f.likeWeight).toBe(SIGNAL_WEIGHTS.LIKE);
    expect(f.dislikeWeight).toBe(SIGNAL_WEIGHTS.DISLIKE);
    expect(f.playlistAddWeight).toBe(SIGNAL_WEIGHTS.PLAYLIST_ADD);
    expect(f.completionWeight).toBe(SIGNAL_WEIGHTS.COMPLETION);
    expect(f.repeatCompletionWeight).toBe(SIGNAL_WEIGHTS.REPEAT_COMPLETION);
    expect(f.earlySkipWeight).toBe(SIGNAL_WEIGHTS.EARLY_SKIP_PLAYLIST);
  });

  it("reads the thresholds from the ranking, charts and listen constants", () => {
    expect(f.halfLifeDays).toBe(HALF_LIFE_MS / (24 * 60 * 60 * 1000));
    expect(f.confidenceLevelPct).toBe(95);
    expect(WILSON_Z).toBe(1.96); // the z the 95 % claim is bound to
    expect(f.minVoters).toBe(MIN_VOTERS);
    expect(f.publishedMinTracks).toBe(PUBLISHED_MIN_TRACKS);
    expect(f.chartLimit).toBe(CHART_LIMIT);
    expect(f.reactionUnlockSeconds).toBe(VERIFIED_FOR_REACTION_MS / 1000);
    expect(f.freshPoolSize).toBe(FRESH_POOL_SIZE);
  });

  it("keeps the published threshold at the card's 20 and the limit at 100", () => {
    expect(PUBLISHED_MIN_TRACKS).toBe(20);
    expect(CHART_LIMIT).toBe(100);
  });
});
