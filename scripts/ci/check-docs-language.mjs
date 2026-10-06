#!/usr/bin/env node
// AGENTS §9 — documentation is English. Cyrillic outside code blocks/inline code is a defect.
// Skips legacy/, messages/, node_modules, tests/fixtures. Usage: node scripts/ci/check-docs-language.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : '.');
const SKIP = new Set(['node_modules', '.git', 'legacy', 'messages', '.next']);
function walk(d) {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return [];
    const p = path.join(d, e.name);
    if (e.isDirectory()) return /fixtures$/.test(p) ? [] : walk(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}
let bad = 0;
for (const f of walk(ROOT)) {
  let inFence = false;
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (inFence) return;
    const text = line.replace(/`[^`]*`/g, '');
    if (/[\u0400-\u04FF]/.test(text)) { console.error(`NON-ENGLISH  ${path.relative(ROOT, f)}:${i + 1}: ${line.trim().slice(0, 100)}`); bad++; }
  });
}
console.log(`docs-language: ${bad} violations`);
process.exit(bad ? 1 : 0);
