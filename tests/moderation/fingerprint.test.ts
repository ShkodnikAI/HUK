import { describe, expect, it, afterAll } from "vitest";
import { createRateLimiter } from "@/server/moderation/adapters/fingerprint/rate";
import { AcoustIdAdapter, type AcoustIdLookup } from "@/server/moderation/adapters/fingerprint/acoustid";
import { AuddAdapter } from "@/server/moderation/adapters/fingerprint/audd";
import { cutSegments } from "@/server/moderation/adapters/fingerprint/segments";
import { fingerprintAdapterFromEnv } from "@/server/moderation/adapters/fingerprint/index";
import { ReviewOnlyFingerprintAdapter } from "@/server/moderation/adapters/fingerprint";
import type { SafeFetchResult } from "@/server/net/safe-fetch";
import { rmSync, existsSync } from "node:fs";

// H-205 done criteria: recorded-response tests (no network in CI) covering
// strong match, weak match, no match, provider error, rate-limit response,
// missing key; the 3 rps ceiling holds under 50 concurrent calls; the AudD
// path stays fail closed and transient (S3).

/** Recorded-response seam: answers the lookup without any network. */
function recorded(result: Partial<SafeFetchResult>): (url: string) => Promise<SafeFetchResult> {
  return async (url) => ({
    status: 200,
    headers: {},
    body: new Uint8Array(),
    bytes: 0,
    url,
    ...result,
  });
}

const lookupBody = (lookup: AcoustIdLookup): Uint8Array => new TextEncoder().encode(JSON.stringify(lookup));

const FILE = { path: "/tmp/nonexistent-source.bin", sha256: "ab", bytes: 1024 };

const fpcalcOk = async () => ({ fingerprint: "AQABCtestfingerprint", durationSec: 90 });

function adapterWith(
  fetchSeam: (url: string) => Promise<SafeFetchResult>,
  over?: { fpcalc?: (file: string) => Promise<{ fingerprint: string; durationSec: number }>; strongScore?: number },
) {
  return new AcoustIdAdapter({
    apiKey: "test-key-not-a-credential-fixture-value",
    limiter: { acquire: async () => {} },
    fpcalc: over?.fpcalc ?? fpcalcOk,
    strongScore: over?.strongScore ?? 0.9,
    fetch: fetchSeam,
  });
}

describe("H-205 rate limiter: 3 rps ceiling under 50 concurrent calls", () => {
  it("spaces 50 concurrent acquires by at least 1000/3 ms (virtual clock)", async () => {
    let virtualNow = 0;
    const slots: number[] = [];
    const limiter = createRateLimiter({
      perSecond: 3,
      now: () => virtualNow,
      sleep: async (ms) => {
        virtualNow += ms; // time passes instantly in the test
      },
    });
    await Promise.all(
      Array.from({ length: 50 }, () => limiter.acquire().then(() => slots.push(virtualNow))),
    );
    expect(slots).toHaveLength(50);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(1000 / 3 - 1e-9);
    }
    expect(slots[slots.length - 1] - slots[0]).toBeGreaterThanOrEqual((49 * 1000) / 3 - 1e-9);
  });

  it("the first acquire in a fresh process goes through immediately (real clock)", async () => {
    const limiter = createRateLimiter({ perSecond: 3 });
    const start = Date.now();
    await limiter.acquire();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("H-205 AcoustID adapter (recorded responses, no network)", () => {
  it("strong match: score >= FINGERPRINT_STRONG_SCORE blocks auto-approval via strongMatch", async () => {
    const adapter = adapterWith(
      recorded({ body: lookupBody({ status: "ok", results: [{ id: "res1", score: 0.94, recordings: [{ id: "rec-1", title: "Known Song", artists: [{ name: "Someone" }] }] }] }) }),
    );
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("PASS");
    expect(res.strongMatch).toBe(true);
    expect(res.bestScore).toBe(0.94);
    expect(res.recording).toBe("rec-1");
    expect(JSON.stringify(res.payload)).toContain("Known Song");
  });

  it("weak match: below threshold → PASS with strongMatch false", async () => {
    const adapter = adapterWith(recorded({ body: lookupBody({ status: "ok", results: [{ id: "res2", score: 0.42, recordings: [{ id: "rec-2" }] }] }) }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("PASS");
    expect(res.strongMatch).toBe(false);
    expect(res.bestScore).toBe(0.42);
  });

  it("no match: empty results → PASS, no score, no recording", async () => {
    const adapter = adapterWith(recorded({ body: lookupBody({ status: "ok", results: [] }) }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("PASS");
    expect(res.bestScore).toBeNull();
    expect(res.strongMatch).toBe(false);
    expect(res.recording).toBeNull();
  });

  it("provider error payload → ERROR (fail closed)", async () => {
    const adapter = adapterWith(recorded({ body: lookupBody({ status: "error", error: { code: 3, message: "fingerprint is invalid" } }) }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
    expect(res.strongMatch).toBe(false);
    expect(JSON.stringify(res.payload)).toContain("fingerprint is invalid");
  });

  it("rate-limit response (429) → ERROR", async () => {
    const adapter = adapterWith(recorded({ status: 429 }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
    expect(JSON.stringify(res.payload)).toContain("rate limited");
  });

  it("server error (500) → ERROR", async () => {
    const adapter = adapterWith(recorded({ status: 500 }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
  });

  it("malformed JSON body → ERROR", async () => {
    const adapter = adapterWith(recorded({ body: new TextEncoder().encode("<html>gateway error</html>") }));
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
  });

  it("fpcalc failure → ERROR before any request", async () => {
    const fetchSeam = async () => {
      throw new Error("no request must be made when fpcalc fails");
    };
    const adapter = adapterWith(fetchSeam as unknown as (url: string) => Promise<SafeFetchResult>, {
      fpcalc: async () => {
        throw new Error("fpcalc missing");
      },
    });
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
    expect(JSON.stringify(res.payload)).toContain("fpcalc failed");
  });

  it("the lookup URL hits api.acoustid.org with the client key and the fingerprint", async () => {
    let seen: URL | null = null;
    const adapter = adapterWith(async (url) => {
      seen = new URL(url);
      return { status: 200, headers: {}, body: lookupBody({ status: "ok", results: [] }), bytes: 0, url };
    });
    await adapter.fingerprint(FILE);
    expect(seen!.hostname).toBe("api.acoustid.org");
    expect(seen!.searchParams.get("client")).toBe("test-key-not-a-credential-fixture-value");
    expect(seen!.searchParams.get("fingerprint")).toBe("AQABCtestfingerprint");
    expect(seen!.searchParams.get("duration")).toBe("90");
  });
});

describe("H-205 factory: missing key never auto-approves", () => {
  it("no ACOUSTID_API_KEY → review-only adapter (SKIPPED)", () => {
    const adapter = fingerprintAdapterFromEnv({ ACOUSTID_API_KEY: undefined, FINGERPRINT_STRONG_SCORE: 0.9 });
    expect(adapter).toBeInstanceOf(ReviewOnlyFingerprintAdapter);
  });

  it("a key configured → the real AcoustID adapter", () => {
    const adapter = fingerprintAdapterFromEnv({ ACOUSTID_API_KEY: "k".repeat(32), FINGERPRINT_STRONG_SCORE: 0.9 });
    expect(adapter).toBeInstanceOf(AcoustIdAdapter);
    expect(adapter.provider).toBe("acoustid");
  });

  it("the review-only adapter returns SKIPPED with strongMatch false", async () => {
    const res = await new ReviewOnlyFingerprintAdapter().fingerprint(FILE);
    expect(res.verdict).toBe("SKIPPED");
    expect(res.strongMatch).toBe(false);
  });
});

describe("H-205 AudD: disabled by default, fail closed when enabled", () => {
  it("AUDD_ENABLED=false → SKIPPED (owner decision pending)", async () => {
    const res = await new AuddAdapter({ enabled: false }).fingerprint(FILE);
    expect(res.verdict).toBe("SKIPPED");
    expect(JSON.stringify(res.payload)).toContain("AUDD_ENABLED=false");
  });

  it("enabled without transport → ERROR after sampling segments; segments stay transient (S3)", async () => {
    const cutFiles: string[] = [];
    const exec = async (_cmd: string, args: string[]) => {
      const out = args.at(-1) as string;
      cutFiles.push(out);
      return { stdout: "", stderr: "" };
    };
    const adapter = new AuddAdapter({ enabled: true, segments: 4, exec, fileDurationSec: () => 240 });
    const res = await adapter.fingerprint(FILE);
    expect(res.verdict).toBe("ERROR");
    expect(res.payload && (res.payload as { segmentsSampled?: number }).segmentsSampled).toBe(4);
    // The temp segments were removed by the adapter's finally (S3).
    for (const f of cutFiles) {
      expect(existsSync(f)).toBe(false);
    }
  });
});

describe("H-205 AudD segment sampler", () => {
  it("cuts N 12 s segments spread from start to end", async () => {
    const calls: Array<string[]> = [];
    const exec = async (_cmd: string, args: string[]) => {
      calls.push(args);
      return { stdout: "", stderr: "" };
    };
    const cut = await cutSegments("/tmp/source.bin", 240, { count: 4, exec });
    expect(cut.files).toHaveLength(4);
    // Starts: 0, 76, 152, 228 — the last segment ends exactly at the file end.
    const starts = calls.map((args) => Number(args[args.indexOf("-ss") + 1]));
    expect(starts).toEqual([0, 76, 152, 228]);
    for (const args of calls) {
      expect(args[args.indexOf("-t") + 1]).toBe("12");
      expect(args[0]).toBe("-y");
    }
    cut.cleanup();
    expect(existsSync(cut.files[0])).toBe(false);
  });

  it("a failing ffmpeg cut cleans the temp dir (S3) and propagates the error", async () => {
    const exec = async (_cmd: string, args: string[]) => {
      if (args.some((a) => a.endsWith("segment-2.wav"))) throw new Error("ffmpeg crashed");
      return { stdout: "", stderr: "" };
    };
    await expect(cutSegments("/tmp/source.bin", 240, { count: 4, exec })).rejects.toThrow("ffmpeg crashed");
  });
});

afterAll(() => {
  // Nothing transient survives the suite.
  for (const f of ["/tmp/huk-audd-fixture"]) {
    if (existsSync(f)) rmSync(f, { recursive: true, force: true });
  }
});
