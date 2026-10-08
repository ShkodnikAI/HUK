// AudD segment sampling (H-205, task 2): the recognition request needs
// short audio excerpts, not the whole file. N segments (default 4) of 12 s
// are cut from start/middle/end of the transient moderation file with
// ffmpeg; every segment lives inside a private temp directory that is
// removed in `finally`-equivalent cleanup — on success, on error and on
// abort (S3: no persistent copy of user audio).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AUDD_SEGMENT_SEC = 12;

export type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileFn = (cmd, args, opts) => promisify(execFile)(cmd, args, { timeout: opts.timeout });

export type SegmentCut = {
  files: string[];
  /** Removes the private temp directory (idempotent). */
  cleanup: () => void;
};

export type SegmentOpts = {
  count?: number;
  exec?: ExecFileFn;
  segmentSec?: number;
};

/**
 * Cuts `count` 12 s segments spread over the file (start → end). The
 * caller MUST call `cleanup()` in a finally block.
 */
export async function cutSegments(
  filePath: string,
  fileDurationSec: number,
  opts: SegmentOpts = {},
): Promise<SegmentCut> {
  const count = opts.count ?? 4;
  const segmentSec = opts.segmentSec ?? AUDD_SEGMENT_SEC;
  const exec = opts.exec ?? defaultExec;
  const dir = mkdtempSync(join(tmpdir(), "huk-audd-"));

  const usable = Math.max(0, fileDurationSec - segmentSec);
  const starts: number[] = [];
  for (let i = 0; i < count; i++) {
    // Evenly spread: the first segment starts at 0, the last ends at the
    // file end; a single segment starts at 0.
    starts.push(count === 1 ? 0 : Math.round((usable * i) / (count - 1)));
  }

  const files: string[] = [];
  try {
    for (let i = 0; i < count; i++) {
      const out = join(dir, `segment-${i}.wav`);
      await exec(
        "ffmpeg",
        ["-y", "-ss", String(starts[i]), "-t", String(segmentSec), "-i", filePath, "-ac", "1", "-ar", "16000", out],
        { timeout: 30_000 },
      );
      files.push(out);
    }
    return { files, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true }); // S3: nothing survives a failure
    throw e;
  }
}
