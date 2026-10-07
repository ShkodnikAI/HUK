import { describe, expect, it } from "vitest";
import {
  computeSkew,
  expectedOffsetMs,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  needsDriftCorrection,
  nextPollDelayMs,
  serverNow,
  shouldResyncOnOnline,
  shouldResyncOnVisibility,
} from "@/lib/sync/clock";

// H-105 contract tests: skew, drift correction, seek offset and adaptive
// polling — all against a fake clock (explicit timestamps).

describe("skew (H-105)", () => {
  it("computes skew as serverClock − clientClock, positive and negative", () => {
    expect(computeSkew(1_000_000, 999_000)).toBe(1_000);
    expect(computeSkew(500_000, 501_500)).toBe(-1_500);
  });

  it("serverNow applies the skew to the client clock", () => {
    const skew = computeSkew(2_000_000, 1_999_000);
    expect(serverNow(1_999_500, skew)).toBe(2_000_500);
  });
});

describe("seek offset (H-105)", () => {
  const slot = { startsAt: 1_000_000, endsAt: 1_180_000 }; // 180 s slot

  it("returns the elapsed time inside the slot", () => {
    expect(expectedOffsetMs(slot, 1_090_000)).toBe(90_000);
  });

  it("clamps to 0 before the slot starts and to the duration after it ends", () => {
    expect(expectedOffsetMs(slot, 900_000)).toBe(0);
    expect(expectedOffsetMs(slot, 2_000_000)).toBe(180_000);
  });

  it("drives a seek: drift beyond 3 s corrects, within 3 s does not", () => {
    const nowServer = 1_090_000;
    const expected = expectedOffsetMs(slot, nowServer);
    expect(needsDriftCorrection(expected, expected + 2_999)).toBe(false);
    expect(needsDriftCorrection(expected, expected + 3_000)).toBe(false);
    expect(needsDriftCorrection(expected, expected + 3_001)).toBe(true);
    expect(needsDriftCorrection(expected, expected - 10_000)).toBe(true);
    // The seek target equals the expected offset.
    expect(expected).toBe(90_000);
  });
});

describe("adaptive polling (H-105)", () => {
  it("polls at min(30 s, time until the slot ends) plus a small buffer", () => {
    const nowServer = 1_000_000;
    expect(nextPollDelayMs(nowServer, nowServer + 5_000)).toBe(5_250);
    expect(nextPollDelayMs(nowServer, nowServer + 60_000)).toBe(MAX_POLL_INTERVAL_MS);
  });

  it("floors at 1 s and polls fast when nothing is playing", () => {
    const nowServer = 1_000_000;
    expect(nextPollDelayMs(nowServer, nowServer + 100)).toBe(MIN_POLL_INTERVAL_MS);
    expect(nextPollDelayMs(nowServer, null)).toBe(MIN_POLL_INTERVAL_MS);
    expect(nextPollDelayMs(nowServer, nowServer - 5_000)).toBe(MIN_POLL_INTERVAL_MS);
  });
});

describe("resync policy (H-105)", () => {
  it("re-syncs when the tab becomes visible again, not when hidden", () => {
    expect(shouldResyncOnVisibility("visible")).toBe(true);
    expect(shouldResyncOnVisibility("hidden")).toBe(false);
  });

  it("re-syncs when connectivity returns", () => {
    expect(shouldResyncOnOnline(true)).toBe(true);
    expect(shouldResyncOnOnline(false)).toBe(false);
  });
});
