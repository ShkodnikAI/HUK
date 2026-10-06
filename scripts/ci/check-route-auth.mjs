#!/usr/bin/env node
// S1 — every mutating route handler and every /api/mod|admin handler must call the central guard,
// or be listed (with a reason) in scripts/ci/public-routes.txt.
// Usage: node scripts/ci/check-route-auth.mjs [--root <dir>] [--json]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const rootIdx = args.indexOf('--root');
const ROOT = path.resolve(rootIdx >= 0 ? args[rootIdx + 1] : '.');
const asJson = args.includes('--json');
const API_DIR = path.join(ROOT, 'src', 'app', 'api');
const ALLOW_FILE = path.join(path.dirname(new URL(import.meta.url).pathname), 'public-routes.txt');
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const GUARD = /\b(requireUser|requireRole|requireSession|requireAdmin|requireModerator|withGuard)\s*\(/;

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /^route\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
  });
}

function routePath(file) {
  const rel = path.relative(API_DIR, path.dirname(file)).split(path.sep).filter(Boolean);
  return '/api' + (rel.length ? '/' + rel.map((s) => s.replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1')).join('/') : '');
}

// strip comments and string literals so braces inside them do not confuse matching
function sanitize(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m.replace(/[^\n]/g, ' '));
}

function matchClose(s, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i;
  }
  return -1;
}

function handlers(raw) {
  const clean = sanitize(raw);
  const out = [];
  for (const m of METHODS) {
    const fn = new RegExp(`export\\s+(?:async\\s+)?function\\s+${m}\\b`).exec(clean);
    if (fn) {
      const p = clean.indexOf('(', fn.index);
      const pc = matchClose(clean, p, '(', ')');
      const b = clean.indexOf('{', pc);
      const be = matchClose(clean, b, '{', '}');
      out.push({ method: m, body: raw.slice(b, be + 1) });
      continue;
    }
    const cn = new RegExp(`export\\s+const\\s+${m}\\b`).exec(clean);
    if (cn) {
      const next = clean.slice(cn.index + 1).search(/\nexport\s/);
      const end = next < 0 ? raw.length : cn.index + 1 + next;
      out.push({ method: m, body: raw.slice(cn.index, end) });
    }
  }
  return out;
}

const allow = new Map();
const allowProblems = [];
if (fs.existsSync(ALLOW_FILE)) {
  fs.readFileSync(ALLOW_FILE, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)\s+#\s*(\S.*)$/.exec(t);
    if (!m) allowProblems.push(`public-routes.txt:${i + 1}: needs "METHOD /path  # reason" (reason is mandatory): ${t}`);
    else allow.set(`${m[1]} ${m[2]}`, false);
  });
}

const violations = [];
const seen = [];
for (const file of walk(API_DIR)) {
  const rp = routePath(file);
  const protectedPrefix = /^\/api\/(mod|moderation|admin)(\/|$)/.test(rp);
  for (const h of handlers(fs.readFileSync(file, 'utf8'))) {
    const key = `${h.method} ${rp}`;
    seen.push(key);
    const needs = MUTATING.has(h.method) || protectedPrefix;
    if (!needs) continue;
    if (GUARD.test(sanitize(h.body))) continue; // comments and strings do not count
    if (allow.has(key)) { allow.set(key, true); continue; }
    violations.push({ route: key, file: path.relative(ROOT, file), why: protectedPrefix && !MUTATING.has(h.method) ? 'moderation/admin route without guard' : 'mutating handler without guard' });
  }
}
const stale = [...allow].filter(([k, used]) => !used && !seen.includes(k)).map(([k]) => k);

if (asJson) console.log(JSON.stringify({ violations, stale, allowProblems }, null, 2));
else {
  if (!fs.existsSync(API_DIR)) console.log(`route-auth-guard: no ${path.relative(ROOT, API_DIR) || API_DIR} yet — nothing to check`);
  for (const v of violations) console.error(`VIOLATION  ${v.route}  (${v.file})  ${v.why}`);
  for (const p of allowProblems) console.error(`ALLOWLIST  ${p}`);
  for (const s of stale) console.warn(`warning: stale allowlist entry (route not found): ${s}`);
  console.log(`route-auth-guard: ${seen.length} handlers scanned, ${violations.length} violations`);
}
process.exit(violations.length || allowProblems.length ? 1 : 0);
