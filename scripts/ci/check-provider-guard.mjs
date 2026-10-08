#!/usr/bin/env node
// S6 (H-204) — provider adapters may never call the trusted transport
// outside the budget fuse. Enforcement is structural:
//   1. No file under src/server/moderation/adapters/** may contain the
//      literal `trustedFetch` — adapters request through
//      guardedProviderFetch (adapters/provider-fetch.ts), which wraps
//      trustedFetch in budget.guard. One door, one audited place.
//   2. provider-fetch.ts itself must keep its single trustedFetch call
//      lexically INSIDE a guard( callback: the scanner below tracks
//      guard( openings and fails when a trustedFetch( call site sits at
//      depth 0 (top level / module scope).
// Usage: node scripts/ci/check-provider-guard.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : '.');
const ADAPTERS = path.join(ROOT, 'src/server/moderation/adapters');
const GATE = path.join(ADAPTERS, 'provider-fetch.ts');

let bad = 0;
function fail(rel, line, msg) {
  console.error(`PROVIDER-GUARD  ${rel}:${line}: ${msg}`);
  bad++;
}

function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | line | block | squote | dquote | template
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { mode = 'squote'; out += ' '; i += 1; continue; }
      if (c === '"') { mode = 'dquote'; out += ' '; i += 1; continue; }
      if (c === '`') { mode = 'template'; out += ' '; i += 1; continue; }
      out += c; i += 1; continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; } else { out += ' '; }
      i += 1; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out += '  '; i += 2; }
      else { out += c === '\n' ? '\n' : ' '; i += 1; }
      continue;
    }
    const q = mode === 'squote' ? "'" : mode === 'dquote' ? '"' : '`';
    if (c === '\\') { out += '  '; i += 2; continue; }
    if (c === '\n') { out += '\n'; i += 1; continue; }
    if (c === q) { mode = 'code'; out += ' '; i += 1; continue; }
    out += ' '; i += 1;
  }
  return out;
}

/** Line numbers (1-based) of `trustedFetch(` call sites at guard-depth 0. */
function unguardedTrustedFetchLines(src) {
  const code = stripCommentsAndStrings(src);
  const lines = code.split('\n');
  const hits = [];
  let depth = 0; // number of open guard( callbacks on the current line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // count guard( openings and their closings crudely but consistently:
    // every '(' after a guard token opens, every ')' at line end closes —
    // the scanner tracks net parens between them instead.
    const guardOpens = (line.match(/\bguard\s*\(/g) || []).length;
    const call = line.includes('trustedFetch(');
    if (call && depth === 0 && guardOpens === 0) hits.push(i + 1);
    // net paren balance of the line (guard callbacks may span lines)
    let net = 0;
    for (const ch of line) {
      if (ch === '(') net++;
      else if (ch === ')') net--;
    }
    depth += net;
  }
  return hits;
}

if (!fs.existsSync(ADAPTERS)) {
  console.log('provider-guard: no adapters directory — nothing to check');
  process.exit(0);
}

// Recursive walk (H-205): provider adapters may live in subdirectories
// (adapters/fingerprint/**), the tripwire covers every one of them.
function walkAdapters(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walkAdapters(p);
    return /\.(ts|tsx|mts|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

const files = walkAdapters(ADAPTERS).sort();

for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  const src = fs.readFileSync(f, 'utf8');
  if (path.resolve(f) === path.resolve(GATE)) {
    // The gate itself: exactly one trustedFetch door, lexically inside guard.
    const code = stripCommentsAndStrings(src);
    const callCount = (code.match(/\btrustedFetch\s*\(/g) || []).length;
    if (callCount === 0) fail(rel, 1, 'provider-fetch.ts lost its guarded trustedFetch call — adapters have no door');
    if (callCount > 1) fail(rel, 1, `provider-fetch.ts must hold exactly one trustedFetch call, found ${callCount}`);
    if (!/\bguard\s*\(/.test(code)) fail(rel, 1, 'provider-fetch.ts does not call budget guard( — the door is unguarded');
    for (const line of unguardedTrustedFetchLines(src)) {
      fail(rel, line, 'trustedFetch( call outside a guard( callback (S6)');
    }
    continue;
  }
  // Every other adapter file: the trusted transport is forbidden outright.
  const code = stripCommentsAndStrings(src);
  code.split('\n').forEach((line, i) => {
    if (line.includes('trustedFetch')) {
      fail(rel, i + 1, 'adapter references trustedFetch directly — use guardedProviderFetch (S6, H-204)');
    }
  });
}

console.log(`provider-guard: ${bad} violations in ${files.length} adapter files`);
process.exit(bad ? 1 : 0);
