#!/usr/bin/env node
// S4 — server code must not make raw outbound HTTP calls. User URLs: src/server/net/safe-fetch.ts.
// Fixed provider hosts: src/server/net/trusted-fetch.ts. Usage: node scripts/ci/check-no-raw-fetch.mjs [--root <dir>]
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : '.');
const SCOPES = ['src/server', 'src/worker', 'src/app/api'];
const ALLOWED = new Set(['src/server/net/safe-fetch.ts', 'src/server/net/trusted-fetch.ts']);
const PATTERN = /(?<![\w.])(fetch|axios|got|ky)\s*\(|\bundici\b|\bhttps?\.(request|get)\s*\(|from\s+['"](axios|got|node-fetch|undici|ky)['"]/;
function walk(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
  });
}
let bad = 0;
for (const s of SCOPES) for (const f of walk(path.join(ROOT, s))) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  if (ALLOWED.has(rel)) continue;
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (PATTERN.test(code)) { console.error(`RAW-FETCH  ${rel}:${i + 1}: ${line.trim()}`); bad++; }
  });
}
console.log(`no-raw-fetch: ${bad} violations`);
process.exit(bad ? 1 : 0);
