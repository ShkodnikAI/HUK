#!/usr/bin/env node
// Node-runtime-only guard (H-109). src/instrumentation.ts validates the
// environment at boot in the Node.js server process (S8); Next.js edge
// runtime has no equivalent boot hook in this codebase, so edge code is
// banned until the boot-validation design covers it.
//
// Fails when any of the following exists:
//   - a middleware entry point at the Next.js conventions: middleware.{ts,tsx,js,jsx}
//     or proxy.{ts,tsx,js,jsx} (Next 16 renamed middleware.ts to proxy.ts —
//     both names are covered) at the repo root, in src/, or in src/app/;
//   - `export const runtime = "edge"` in any file under src/ (both quote
//     styles, const/let/var).
//
// Usage: node scripts/ci/check-no-edge-runtime.mjs   (wired into ci.yml `invariants`)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const EDGE_RUNTIME_EXPORT = /export\s+(?:const|let|var)\s+runtime\s*=\s*["']edge["']/;
const EDGE_ENTRY_NAMES = new Set([
  "middleware.ts", "middleware.tsx", "middleware.js", "middleware.jsx",
  "proxy.ts", "proxy.tsx", "proxy.js", "proxy.jsx",
]);
const ENTRY_DIRS = [".", join("src"), join("src", "app")];
const SCAN_EXTS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (SCAN_EXTS.has(name.slice(name.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

const violations = [];

// 1. Edge entry points (middleware.ts / proxy.ts conventions).
for (const dir of ENTRY_DIRS) {
  for (const name of readdirSync(dir).sort()) {
    if (!EDGE_ENTRY_NAMES.has(name)) continue;
    const key = relative(".", join(dir, name)).split(sep).join("/");
    violations.push(`${key}: edge entry point found — Node runtime only (H-109)`);
  }
}

// 2. `export const runtime = "edge"` anywhere under src/.
for (const file of walk("src")) {
  const key = relative(".", file).split(sep).join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (EDGE_RUNTIME_EXPORT.test(lines[i])) {
      violations.push(`${key}:${i + 1}: edge runtime export found — Node runtime only (H-109)`);
    }
  }
}

if (violations.length > 0) {
  console.error("check-no-edge-runtime: FAILED — edge runtime code found:");
  for (const v of violations) console.error(`  - ${v}`);
  console.error(
    "src/instrumentation.ts (S8 boot validation) covers the Node.js server process only; " +
      "see docs/LIMITATIONS.md. Edge code needs an owner decision first.",
  );
  process.exit(1);
}

console.log(
  "check-no-edge-runtime: OK — no middleware/proxy entry points, no edge runtime exports (Node runtime only)",
);
