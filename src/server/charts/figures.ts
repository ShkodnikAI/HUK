// The "How charts work" figures (H-305): every number the page renders is
// read from the ranking constants — never hardcoded in prose — so the page
// cannot drift from the algorithm. The contract test
// (tests/charts/figures.test.ts) compares each figure with
// src/server/ranking/signals.ts exactly.

import {
  HALF_LIFE_MS,
  MIN_VOTERS,
  SIGNAL_WEIGHTS,
  WILSON_Z,
} from "@/server/ranking/signals";
import { VERIFIED_FOR_REACTION_MS } from "@/server/listen/session";
import { FRESH_POOL_SIZE } from "@/server/broadcast/scheduler";
import { CHART_LIMIT } from "@/server/charts/service";
import { PUBLISHED_MIN_TRACKS } from "@/server/charts/categories";

const DAY_MS = 24 * 60 * 60 * 1000;

export type HowChartsFigures = {
  likeWeight: number;
  dislikeWeight: number;
  playlistAddWeight: number;
  completionWeight: number;
  repeatCompletionWeight: number;
  earlySkipWeight: number;
  halfLifeDays: number;
  /** The Wilson level in percent — WILSON_Z 1.96 is the 95 % bound. */
  confidenceLevelPct: number;
  minVoters: number;
  publishedMinTracks: number;
  chartLimit: number;
  reactionUnlockSeconds: number;
  freshPoolSize: number;
};

export function howChartsFigures(): HowChartsFigures {
  return {
    likeWeight: SIGNAL_WEIGHTS.LIKE,
    dislikeWeight: SIGNAL_WEIGHTS.DISLIKE,
    playlistAddWeight: SIGNAL_WEIGHTS.PLAYLIST_ADD,
    completionWeight: SIGNAL_WEIGHTS.COMPLETION,
    repeatCompletionWeight: SIGNAL_WEIGHTS.REPEAT_COMPLETION,
    earlySkipWeight: SIGNAL_WEIGHTS.EARLY_SKIP_PLAYLIST,
    halfLifeDays: HALF_LIFE_MS / DAY_MS,
    confidenceLevelPct: WILSON_Z === 1.96 ? 95 : Number.NaN, // fails loud if z ever moves
    minVoters: MIN_VOTERS,
    publishedMinTracks: PUBLISHED_MIN_TRACKS,
    chartLimit: CHART_LIMIT,
    reactionUnlockSeconds: VERIFIED_FOR_REACTION_MS / 1000,
    freshPoolSize: FRESH_POOL_SIZE,
  };
}
