#!/usr/bin/env node
// S8 guard v2 (H-107 + H-109). Two layers of enforcement:
//   1. ESLint no-restricted-syntax selectors (eslint.config.mjs) — AST level,
//      catch every spelling (process.env, process["env"], globalThis.process,
//      destructuring/aliasing of process, Bun.env, Deno.env, import.meta.env);
//   2. THIS script — text level, two jobs that config cannot do:
//        a) keep the single documented exception single: exactly one line in
//           src/ may carry a direct process.env read together with the marker
//           H-107-EXCEPTION (src/instrumentation.ts);
//        b) fail on literal `process.env` code outside src/server/env.ts.
//      Comments and string literals are stripped before matching, so a comment
//      mentioning the phrase is NOT a violation (the H-107 v1 false positive).
// Residual risk (documented): regex literals and `${}` interpolations inside
// template literals are not parsed here — they are the ESLint layer's job.
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

// Replace comments and string-literal contents with spaces, preserving line
// numbers and code positions. Deliberately conservative: it cannot parse
// regex literals or template `${}` interpolation — that is the ESLint
// layer's responsibility (see header).
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  // modes: code | line | block | squote | dquote | template
  let mode = "code";
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; out += "  "; i += 2; continue; }
      if (c === "/" && d === "*") { mode = "block"; out += "  "; i += 2; continue; }
      if (c === "'") { mode = "squote"; out += " "; i += 1; continue; }
      if (c === '"') { mode = "dquote"; out += " "; i += 1; continue; }
      if (c === "`") { mode = "template"; out += " "; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out += "\n"; } else { out += " "; }
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") { mode = "code"; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i += 1; }
      continue;
    }
    // string modes
    const q = mode === "squote" ? "'" : mode === "dquote" ? '"' : "`";
    if (c === "\\") { out += "  "; i += 2; continue; }
    if (c === "\n") { out += "\n"; i += 1; continue; }
    if (c === q) { mode = "code"; out += " "; i += 1; continue; }
    out += " "; i += 1;
  }
  return out;
}

const files = walk(ROOT);
const violations = [];
let markedCodeLines = 0;

for (const file of files) {
  const key = relative(".", file).split(sep).join("/");
  if (SANCTIONED.has(key)) continue;
  const raw = readFileSync(file, "utf8");
  const rawLines = raw.split("\n");
  const codeLines = stripCommentsAndStrings(raw).split("\n");
  for (let i = 0; i < codeLines.length; i++) {
    if (!codeLines[i].includes("process.env")) continue;
    if (rawLines[i]?.includes(MARKER)) markedCodeLines++;
    else violations.push(`${key}:${i + 1}: direct process.env read in code`);
  }
}

if (markedCodeLines > 1) {
  violations.push(
    `${markedCodeLines} code lines carry the ${MARKER} marker — the direct-read exception must stay single (H-107)`,
  );
}

if (violations.length > 0) {
  console.error("check-no-process-env: FAILED (S8) — direct process.env reads outside src/server/env.ts:");
  for (const v of violations) console.error(`  - ${v}`);
  console.error("Read the environment through loadEnv() from src/server/env.ts instead.");
  process.exit(1);
}

console.log(
  `check-no-process-env: OK — no direct process.env code outside src/server/env.ts ` +
    `(files scanned: ${files.length}, marked exception lines: ${markedCodeLines})`,
);
