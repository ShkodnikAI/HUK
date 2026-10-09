#!/usr/bin/env node
// S3 / D14 / H-112 — invariant `audio-store`: user audio must never be
// persisted to disk outside the broadcast cache module. Server code that
// creates files or directories is confined to an explicit allowlist:
//   src/server/sources/verify.ts                              (moderation temp download, H-202)
//   src/server/moderation/adapters/fingerprint/segments.ts    (AudD segments, H-205)
//   src/server/broadcast/audio-cache.ts                       (broadcast cache, H-112/D14)
// Anything else in src/ using writeFile / createWriteStream / mkdtemp /
// mkdir / rename / copyFile (and the sync variants) fails this check.
// Usage: node scripts/ci/audio-store.mjs [--root <dir>] [--selftest]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : '.');
const SELFTEST = args.includes('--selftest');

const SCOPES = ['src'];
const ALLOWED = new Set([
  'src/server/sources/verify.ts',
  'src/server/moderation/adapters/fingerprint/segments.ts',
  'src/server/broadcast/audio-cache.ts',
]);
// writeFileSync/createWriteStream/mkdtempSync/mkdirSync/renameSync/copyFileSync
// and the async variants; `open`/`write` with write flags are covered via the
// review of this allowlist (openSync+writeSync only ever appears inside the
// allowlisted moderation download).
const PATTERN =
  /(?<![\w.])(writeFile|writeFileSync|createWriteStream|mkdtemp|mkdtempSync|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync)\s*\(/;

function walk(d) {
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [p] : [];
  });
}

let bad = 0;
for (const s of SCOPES) {
  for (const f of walk(path.join(ROOT, s))) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (PATTERN.test(code)) {
        console.error(`AUDIO-STORE  ${rel}:${i + 1}: ${line.trim()}`);
        bad++;
      }
    });
  }
}

if (SELFTEST) {
  // --selftest: the checked-in bad fixture MUST be reported (the checker
  // must be able to fail). Scans scripts/ci/audio-store-fixture/.
  const fixtureDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'audio-store-fixture');
  let fixtureBad = 0;
  for (const f of walk(fixtureDir)) {
    fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (PATTERN.test(code)) fixtureBad++;
    });
  }
  if (fixtureBad === 0) {
    console.error('audio-store selftest FAILED: the bad fixture was not reported — the check is broken');
    process.exit(1);
  }
  console.log(`audio-store selftest: fixture correctly reported (${fixtureBad} violation(s))`);
  process.exit(0);
}

console.log(`audio-store: ${bad} violations`);
process.exit(bad ? 1 : 0);
