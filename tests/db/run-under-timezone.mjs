// H-306: run the DB integration suite against a database whose DEFAULT time
// zone is NOT UTC — the condition that silently broke the station on the
// Owner's host (Europe/Minsk, 2026-10-15) and that green CI (UTC postgres)
// never exercised.
//
// Usage: bun tests/db/run-under-timezone.mjs <IANA-zone>
//   1. ALTER DATABASE <db> SET timezone TO '<zone>' (new connections only);
//   2. prove on a fresh, plain connection (no mechanism) that the effective
//      default really is the requested zone — otherwise the run proves
//      nothing and fails here;
//   3. run `bunx vitest run tests/db`.
//
// The suite must stay green in every zone: app sessions are pinned to UTC by
// the connection mechanism (src/server/db-url.ts, asserted by the
// "mechanism guard" test) and the raw SQL comparisons are pinned to the UTC
// wall clock explicitly (the "raw session" tests use makeClient() without
// the mechanism).

import { execSync } from "node:child_process";
import { Client } from "pg";

const zone = process.argv[2];
if (!zone || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) {
  console.error("usage: bun tests/db/run-under-timezone.mjs <IANA-zone>");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(2);
}
const dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || "huk";

const admin = new Client({ connectionString: url });
await admin.connect();
await admin.query(`ALTER DATABASE "${dbName.replace(/"/g, '""')}" SET timezone TO '${zone}'`);
await admin.end();

// A fresh plain connection must now see the requested default zone.
const probe = new Client({ connectionString: url });
await probe.connect();
const { rows } = await probe.query("SHOW timezone");
await probe.end();
const effective = rows[0]?.TimeZone ?? rows[0]?.timezone;
if (effective !== zone) {
  console.error(`[db-timezone] database default zone is '${effective}', expected '${zone}' — refusing to run`);
  process.exit(1);
}
console.log(`[db-timezone] database default time zone verified: ${effective}`);

try {
  execSync("bunx vitest run tests/db", { stdio: "inherit", env: process.env });
} catch (error) {
  const status = (error as { status?: number }).status ?? 1;
  console.error(`[db-timezone] suite FAILED under database time zone ${zone} (exit ${status})`);
  process.exit(status === 0 ? 1 : status);
}
console.log(`[db-timezone] suite PASSED under database time zone ${zone}`);
