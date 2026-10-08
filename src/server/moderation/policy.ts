// Policy loader (H-204): `policy/moderation-policy.md` is the single source
// of the moderation rules. It is read once at start-up; `policyVersion` is
// derived from the SHA-256 of its content so every ModerationRun records
// exactly which rules decided it. A missing or empty policy file fails loud
// (S9): the worker refuses to run moderation without the policy in place.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ModerationPolicy = {
  /** Raw markdown (goes into the instruction block of the verdict prompt). */
  text: string;
  /** "sha256:<first 16 hex>" of the file content. */
  version: string;
};

let cached: ModerationPolicy | null = null;

/**
 * Loads the policy from `policyPath` (default `<cwd>/policy/moderation-
 * policy.md`). Tests may pass an explicit path or pre-loaded text; production
 * resolves relative to the process working directory (repo root for the
 * worker image, where the policy is copied).
 */
export function loadPolicy(opts?: { path?: string; text?: string; forceReload?: boolean }): ModerationPolicy {
  if (cached && !opts?.forceReload) return cached;
  let text: string;
  if (opts?.text !== undefined) {
    text = opts.text;
  } else {
    const path = opts?.path ?? join(process.cwd(), "policy", "moderation-policy.md");
    // S9 fail loud: a missing policy must stop the stage, not empty-run it.
    text = readFileSync(path, "utf8");
  }
  if (text.trim().length === 0) {
    throw new Error("moderation policy is empty (S9): refusing to run the policy stage");
  }
  cached = {
    text,
    version: `sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`,
  };
  return cached;
}

/** Test seam: drop the cached policy so a later load re-reads. */
export function resetPolicyCache(): void {
  cached = null;
}
