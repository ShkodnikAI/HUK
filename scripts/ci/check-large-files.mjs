#!/usr/bin/env node
// No binaries/databases in git: files > 1 MB or audio/db/archive extensions are rejected
// (tests/fixtures may hold files < 200 KB). Usage: node scripts/ci/check-large-files.mjs [--root <dir>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const ri = args.indexOf('--root');
const ROOT = path.resolve(ri >= 0 ? args[ri + 1] : '.');
const BAD_EXT = /\.(db|sqlite3?|mp3|wav|flac|ogg|m4a|webm|zip|tar|gz|7z)$/i;
const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
let bad = 0;
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const size = fs.statSync(p).size;
  const fixture = f.startsWith('tests/fixtures/') && size < 200 * 1024;
  if (size > 1024 * 1024 || (BAD_EXT.test(f) && !fixture)) { console.error(`BINARY/LARGE  ${f}  (${(size / 1024).toFixed(0)} KB)`); bad++; }
}
console.log(`large-files: ${bad} violations in ${files.length} tracked files`);
process.exit(bad ? 1 : 0);
