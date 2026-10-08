import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isStale,
  MAX_PLAYBACK_RETRIES,
  registerFailure,
  slotKey,
  STALL_REPOLL_MS,
  watchPlaybackFailures,
} from "@/lib/sync/playback";

// H-212 (G3) contracts: the player's failure policy — an audio error
// re-polls immediately, a stall longer than 10 s counts as a failure, the
// same slot is retried at most twice, the budget is per slot. The watcher is
// exercised with an audio mock and fake timers; vitest runs in node.

class AudioMock {
  private listeners = new Map<string, Array<() => void>>();
  loadCalls = 0;
  playCalls = 0;
  paused = true;
  src = "";

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }

  load(): void {
    this.loadCalls++;
  }

  play(): Promise<void> {
    this.playCalls++;
    this.paused = false;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
  }

  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }
}

describe("failure budget (H-212, G3)", () => {
  it("retries the same slot at most twice, then gives up", () => {
    const key = slotKey(1_000, 2_000);
    let state = registerFailure(null, key);
    expect(state).toMatchObject({ key, retries: 1, giveUp: false });
    state = registerFailure(state, key);
    expect(state).toMatchObject({ key, retries: MAX_PLAYBACK_RETRIES, giveUp: false });
    state = registerFailure(state, key);
    expect(state.giveUp).toBe(true);
    expect(state.retries).toBe(MAX_PLAYBACK_RETRIES); // budget not exceeded
  });

  it("the budget is per slot: a new slot starts clean", () => {
    const first = slotKey(1_000, 2_000);
    const second = slotKey(2_000, 3_000);
    let state = registerFailure(null, first);
    state = registerFailure(state, first);
    state = registerFailure(state, second);
    expect(state).toMatchObject({ key: second, retries: 1, giveUp: false });
  });

  it("isStale: a different or absent slot makes the failure state obsolete", () => {
    const key = slotKey(1_000, 2_000);
    const state = registerFailure(null, key);
    expect(isStale(state, key)).toBe(false);
    expect(isStale(state, slotKey(9_000, 10_000))).toBe(true);
    expect(isStale(state, null)).toBe(true);
    expect(isStale(null, key)).toBe(false);
  });
});

describe("watchPlaybackFailures (fake timers + audio mock)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTimers() {
    // Route the watcher through vitest fake timers (the component uses the
    // default Date.now/setInterval; tests pin both).
    return {
      now: () => Date.now(),
      set: (handler: () => void, ms: number) => setInterval(handler, ms),
      clear: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>),
    };
  }

  it("an audio error signals immediately (re-poll within 1 s)", () => {
    const audio = new AudioMock();
    const onFailure = vi.fn();
    watchPlaybackFailures(audio, onFailure, makeTimers());

    audio.emit("error");
    expect(onFailure).toHaveBeenCalledTimes(1);

    // No repeat without a new incident.
    vi.advanceTimersByTime(5_000);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("waiting longer than 10 s signals once; playing resets the stall", () => {
    const audio = new AudioMock();
    const onFailure = vi.fn();
    watchPlaybackFailures(audio, onFailure, makeTimers());

    audio.emit("waiting");
    vi.advanceTimersByTime(STALL_REPOLL_MS - 1);
    expect(onFailure).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFailure).toHaveBeenCalledTimes(1);

    // One signal per incident — no spin loop while still stalled.
    vi.advanceTimersByTime(60_000);
    expect(onFailure).toHaveBeenCalledTimes(1);

    // A new stall after a period of progress signals again.
    audio.emit("playing");
    audio.emit("waiting");
    vi.advanceTimersByTime(STALL_REPOLL_MS);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("progress events cancel a pending stall", () => {
    const audio = new AudioMock();
    const onFailure = vi.fn();
    watchPlaybackFailures(audio, onFailure, makeTimers());

    audio.emit("waiting");
    vi.advanceTimersByTime(5_000);
    audio.emit("timeupdate");
    vi.advanceTimersByTime(60_000);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("detach removes every listener and stops the watchdog", () => {
    const audio = new AudioMock();
    const onFailure = vi.fn();
    const detach = watchPlaybackFailures(audio, onFailure, makeTimers());

    detach();
    audio.emit("error");
    audio.emit("waiting");
    vi.advanceTimersByTime(STALL_REPOLL_MS * 3);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stalled behaves like waiting", () => {
    const audio = new AudioMock();
    const onFailure = vi.fn();
    watchPlaybackFailures(audio, onFailure, makeTimers());

    audio.emit("stalled");
    vi.advanceTimersByTime(STALL_REPOLL_MS);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });
});
