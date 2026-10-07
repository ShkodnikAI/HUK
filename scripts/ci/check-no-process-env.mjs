#!/usr/bin/env node
// S8 guard (H-107): the only sanctioned reader of process.env in src/ is
// src/server/env.ts. Every other module must go through loadEnv() so the
// environment stays validated once, at boot (AGENTS §5 S8, src/server/env.ts).
//
// Single documented exception: src/instrumentation.ts reads process.env.NEXT_PHASE
// on a line marked H-107-EXCEPTION (build-phase skip). The guard allows at most
// ONE marked occurrence across all of src/ — the exception must stay single.
//
// Usage: node scripts/ci/check-no-process-env.mjs   (wired into ci.yml `invariants`)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = "src";
const SANCTIONED = new Set(["src/server/env.ts"]);
const MARKER = "H-107-EXCEPTION";
const EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const violations = [];
let markedOccurrences = 0;

for (const file of files) {
  const key = relative(".", file).split(sep).join("/");
  if (SANCTIONED.has(key)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("process.env")) continue;
    if (lines[i].includes(MARKER)) markedOccurrences++;
    else violations.push(`${key}:${i + 1}: direct process.env read`);
  }
}

if (markedOccurrences > 1) {
  violations.push(
    `${markedOccurrences} occurrences of ${MARKER} found — the direct-read exception must stay single (H-107)`,
  );
}

if (violations.length > 0) {
  console.error("check-no-process-env: FAILED (S8) — direct process.env reads outside src/server/env.ts:");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("Read the environment through loadEnv() from src/server/env.ts instead.");
  process.exit(1);
}

console.log(
  `check-no-process-env: OK — no direct process.env outside src/server/env.ts ` +
    `(files scanned: ${files.length}, marked exceptions: ${markedOccurrences})`,
);
