import { describe, expect, it } from "vitest";
import { technicalCheck, TECHNICAL_MIN_SEC, TECHNICAL_MAX_SEC } from "@/server/moderation/technical";

// H-204 task 5: the ported technical stage. The exec seam keeps these tests
// hermetic (no ffmpeg needed); tests/db/db.test.ts adds one real-ffmpeg
// integration test that CI runs against a synthesised tone.

const okExec = (stdout: string, stderr = "") => async () => ({ stdout, stderr });

describe("H-204 technical stage (ported from legacy/technical-check.ts)", () => {
  it("passes a readable in-window file", async () => {
    const res = await technicalCheck("/tmp/x.mp3", { exec: okExec(JSON.stringify({ format: { duration: "180.5" } })) });
    expect(res).toEqual({ ok: true, durationSec: 180.5 });
  });

  it("rejects unreadable files with a typed reason (no throw)", async () => {
    const res = await technicalCheck("/tmp/x.mp3", {
      exec: async () => {
        throw new Error("spawn failed");
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ffprobe could not read");
  });

  it("rejects damaged/unparseable ffprobe output", async () => {
    const res = await technicalCheck("/tmp/x.mp3", { exec: okExec("not json") });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("duration unreadable");
  });

  it("rejects too-short and too-long durations with the window bounds", async () => {
    const short = await technicalCheck("/tmp/x.mp3", { exec: okExec(JSON.stringify({ format: { duration: String(TECHNICAL_MIN_SEC - 1) } })) });
    expect(short.ok).toBe(false);
    expect(short.reason).toContain("too short");
    const long = await technicalCheck("/tmp/x.mp3", { exec: okExec(JSON.stringify({ format: { duration: String(TECHNICAL_MAX_SEC + 1) } })) });
    expect(long.ok).toBe(false);
    expect(long.reason).toContain("too long");
  });

  it("rejects silence below -55 dB mean volume", async () => {
    const res = await technicalCheck("/tmp/x.mp3", {
      exec: async (cmd, args) => {
        if (cmd === "ffprobe") return { stdout: JSON.stringify({ format: { duration: "60" } }), stderr: "" };
        expect(cmd).toBe("ffmpeg");
        expect(args).toContain("volumedetect");
        return { stdout: "", stderr: "mean_volume: -70.5 dB" };
      },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("silent");
  });

  it("keeps volumedetect optional: a failing silence probe does not block", async () => {
    const res = await technicalCheck("/tmp/x.mp3", {
      exec: async (cmd) => {
        if (cmd === "ffprobe") return { stdout: JSON.stringify({ format: { duration: "60" } }), stderr: "" };
        throw new Error("ffmpeg crashed");
      },
    });
    expect(res.ok).toBe(true);
  });

  it("passes hard timeouts to the exec calls", async () => {
    const seen: Array<{ cmd: string; timeoutMs: number }> = [];
    await technicalCheck("/tmp/x.mp3", {
      probeTimeoutMs: 1111,
      volumeTimeoutMs: 2222,
      exec: async (cmd, _args, opts) => {
        seen.push({ cmd, timeoutMs: opts.timeoutMs });
        if (cmd === "ffprobe") return { stdout: JSON.stringify({ format: { duration: "60" } }), stderr: "" };
        return { stdout: "", stderr: "mean_volume: -20.0 dB" };
      },
    });
    expect(seen).toEqual([
      { cmd: "ffprobe", timeoutMs: 1111 },
      { cmd: "ffmpeg", timeoutMs: 2222 },
    ]);
  });
});
