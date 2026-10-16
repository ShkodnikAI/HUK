// scripts/ci/check-prod-compose.mjs (H-504, task 7) — invariant checker for
// the production compose stack. Reads a RENDERED compose model (JSON) from
// argv[2] — the output of:
//
//   docker compose -f deploy/docker-compose.prod.yml \
//     --env-file deploy/tests/fake-prod.env config --format json > rendered.json
//   node scripts/ci/check-prod-compose.mjs rendered.json
//
// It refuses the model when:
//   1. the project name is not `huk`;
//   2. any service other than `web` publishes a port (task 7);
//   3. `web` publishes a port without an explicit 127.0.0.1 host IP (task 7);
//   4. a dev default survives into the rendered environment (task 7): the
//      dev Postgres password, the dev IP_HASH_SALT (H-103), a NEXTAUTH_URL
//      that is not https or points at localhost/example.com (H-110), the
//      application-default EMAIL_FROM (@example.com), the dev mailpit sink;
//   5. a service runs privileged, shares the host PID namespace, uses
//      host networking, or mounts the Docker socket;
//   6. the Cloudflare tunnel token is empty or an obvious placeholder.
//
// The deliberately broken fixture deploy/tests/bad-compose.fixture.yml must
// be rejected by this script — CI fails if the checker accepts it.
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ci/check-prod-compose.mjs <rendered-compose.json>");
  process.exit(2);
}

let model;
try {
  model = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`FAIL: cannot parse rendered compose JSON (${file}): ${e.message}`);
  process.exit(2);
}

const violations = [];
const bad = (msg) => violations.push(msg);
const str = (v) => (v === undefined || v === null ? "" : String(v));

const services = model.services ?? {};
const names = Object.keys(services).sort();
if (names.length === 0) bad("no services in the rendered model");

// 1. Fixed project name — scripts and docs rely on it (backup/restore/up).
if (model.name !== "huk") bad(`compose project name must be "huk", got "${model.name ?? ""}"`);

for (const [name, svc] of Object.entries(services)) {
  // 2. Port publication: only web may publish, and only on loopback.
  const ports = Array.isArray(svc.ports) ? svc.ports : [];
  for (const p of ports) {
    const hostIp = str(p.host_ip);
    const published = str(p.published);
    if (name !== "web") {
      bad(`service "${name}" publishes port ${published}->${p.target} — only web may publish (task 7)`);
      continue;
    }
    if (hostIp !== "127.0.0.1") {
      bad(
        hostIp === ""
          ? `web publishes ${published} on ALL interfaces — must be bound to 127.0.0.1 (task 7)`
          : `web publishes ${published} on ${hostIp} — must be bound to 127.0.0.1 (task 7)`,
      );
    }
  }

  // 3. Privilege / namespace escapes.
  if (svc.privileged === true) bad(`service "${name}" runs privileged`);
  if (str(svc.pid) === "host") bad(`service "${name}" shares the host PID namespace`);
  if (str(svc.network_mode) === "host") bad(`service "${name}" uses host networking`);
  const volumes = Array.isArray(svc.volumes) ? svc.volumes : [];
  for (const v of volumes) {
    const src = str(typeof v === "string" ? v : v.source);
    const target = str(typeof v === "string" ? v.split(":")[1] : v.target);
    if (src.includes("docker.sock") || target === "/var/run/docker.sock") {
      bad(`service "${name}" mounts the Docker socket`);
    }
  }

  // 4. Dev defaults must not survive into the rendered environment.
  const env = svc.environment ?? {};
  const val = (k) => str(env[k]);
  if (val("POSTGRES_PASSWORD") === "huk") {
    bad(`service "${name}" carries the dev Postgres password (task 7)`);
  }
  if (val("IP_HASH_SALT") === "huk-dev-ip-hash-salt-do-not-use-in-prod") {
    bad(`service "${name}" carries the dev IP_HASH_SALT (H-103)`);
  }
  const nextauth = val("NEXTAUTH_URL");
  if (nextauth !== "") {
    let ok = nextauth.startsWith("https://");
    let host = "";
    try {
      host = new URL(nextauth).hostname;
    } catch {
      ok = false;
    }
    if (["localhost", "127.0.0.1", "::1", "example.com", "www.example.com"].includes(host)) ok = false;
    if (!ok) bad(`service "${name}" NEXTAUTH_URL is not a real https origin: "${nextauth}" (H-110)`);
  }
  if (val("EMAIL_FROM").includes("@example.com")) {
    bad(`service "${name}" EMAIL_FROM still ends in @example.com (application default)`);
  }
  if (val("EMAIL_SERVER").includes("mailpit")) {
    bad(`service "${name}" EMAIL_SERVER points at the dev mailpit sink`);
  }
  if (name === "cloudflared") {
    const token = val("TUNNEL_TOKEN");
    if (token === "" || /^(changeme|CHANGEME|paste-token-here|xxx|test|placeholder)$/.test(token)) {
      bad("cloudflared TUNNEL_TOKEN is empty or an obvious placeholder");
    }
  }
}

if (violations.length > 0) {
  console.error(`FAIL: ${violations.length} prod compose invariant(s) violated (H-504 task 7):`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`prod compose invariants: OK (${names.length} services: ${names.join(", ")})`);
