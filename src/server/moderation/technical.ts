// Technical stage (H-204): port of legacy/technical-check.ts (prototype
// v0.2.1) with hard timeouts and the legacy Russian reasons replaced by
// stable English machine reasons (they land in ModerationRun.payload and
// are shown to moderators, not end users — translation arrives with the
// moderator console). Rules: duration 15 s - 12 min; average volume below
// -55 dB is silence. The volumedetect pass stays optional (a probe failure
// must not block a readable file — legacy behaviour kept deliberately).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TECHNICAL_MIN_SEC = 15;
export const TECHNICAL_MAX_SEC = 12 * 60;
export const TECHNICAL_SILENCE_DB = -55;

export type ExecResult = { stdout: string; stderr: string };
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, opts) => execFileAsync(cmd, args, { timeout: opts.timeoutMs });

export type TechnicalResult = {
  ok: boolean;
  durationSec: number;
  reason?: string;
};

export type TechnicalOpts = {
  exec?: ExecFn;
  probeTimeoutMs?: number;
  volumeTimeoutMs?: number;
};

/**
 * Reads the file with ffprobe, enforces the duration window, then (best
 * effort) runs ffmpeg volumedetect for the silence check. Never throws for
 * file-level conditions — every failure becomes a typed result with a
 * reason; only an unexpected exec crash propagates.
 */
export async function technicalCheck(filePath: string, opts: TechnicalOpts = {}): Promise<TechnicalResult> {
  const exec = opts.exec ?? defaultExec;
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
      { timeoutMs: opts.probeTimeoutMs ?? 30_000 },
    ));
  } catch {
    return { ok: false, durationSec: 0, reason: "ffprobe could not read the file (supported: mp3/wav/ogg/m4a)" };
  }
  let duration = 0;
  try {
    duration = parseFloat(JSON.parse(stdout).format?.duration ?? "0");
  } catch {
    duration = NaN;
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, durationSec: 0, reason: "duration unreadable — the file is damaged or not audio" };
  }
  if (duration < TECHNICAL_MIN_SEC) {
    return { ok: false, durationSec: round(duration), reason: `track too short (minimum ${TECHNICAL_MIN_SEC} seconds)` };
  }
  if (duration > TECHNICAL_MAX_SEC) {
    return { ok: false, durationSec: round(duration), reason: `track too long (maximum ${TECHNICAL_MAX_SEC / 60} minutes)` };
  }

  try {
    const { stderr } = await exec(
      "ffmpeg",
      ["-i", filePath, "-af", "volumedetect", "-f", "null", "-"],
      { timeoutMs: opts.volumeTimeoutMs ?? 30_000 },
    );
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    if (m && parseFloat(m[1]) < TECHNICAL_SILENCE_DB) {
      return { ok: false, durationSec: round(duration), reason: "track is practically silent" };
    }
  } catch {
    // volumedetect is optional — never blocks on its own (legacy behaviour).
  }
  return { ok: true, durationSec: round(duration) };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
