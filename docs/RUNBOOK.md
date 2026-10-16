# HUK Production Runbook (H-504)

Deploying the station on the Owner's own 24/7 Linux server behind a Cloudflare
Tunnel. Written so that someone who has never seen this repository can deploy
from it, top to bottom. Everything is delivered as files; the commands marked
**[not executed here]** run on your host and are yours to execute. The CI
`deploy-smoke` job runs the same files end to end on every PR — those steps
are marked **[verified in CI]**.

Legend: `[verified in CI]` — executed by GitHub Actions on the exact files in
this repo. `[not executed here]` — needs your host, your Cloudflare account or
your DNS; the command is documented, not run by the agent.

---

## 0. What this stack is

```
                        Cloudflare (DNS + proxy, hukradio.com)
                                        │  (outbound-only encrypted tunnel,
                                        │   no inbound ports on your host)
                              ┌─────────▼─────────┐
                              │ cloudflared        │  profile: tunnel
                              │ (official image)   │
                              └─────────┬──────────┘
                     hukradio.com       │ hukradio.com/seed*
                     → http://web:3000  │ → http://seed-audio:80
                              ┌─────────▼──────────┐   ┌──────────────────┐
   127.0.0.1:3100 (admin) ──▶ │ web (Next.js)      │   │ seed-audio       │
   curl /api/health           │ prisma migrate     │   │ (nginx:alpine,   │
                              │ deploy, then start │   │  static /seed)   │
                              └─────────┬──────────┘   └────────┬─────────┘
                              ┌─────────▼──────────┐            │ volume
                              │ postgres (16)      │            │ seed_audio
                              │ never published    │   ┌────────▼─────────┐
                              └────────────────────┘   │ worker (single   │
   volumes: pgdata, audio_cache, seed_audio            │ writer, ffmpeg)  │
   network: huk_internal (project-local)               └──────────────────┘
```

Files that make this up (all in the repo root you cloned):

| File | Role |
|---|---|
| `deploy/docker-compose.prod.yml` | the production stack (NOT an override of the dev `docker-compose.yml`) |
| `deploy/.env.production.example` | template for `deploy/.env` — every required variable |
| `deploy/check-env.sh` | refuses to start when a secret is empty / a dev default survived (S8/S9) |
| `deploy/up.sh` | first start / restart: check-env → build → `up -d --wait` → health |
| `deploy/update.sh` | roll to a git ref or image tag, **automatic rollback** on failed health |
| `deploy/backup.sh` | nightly `pg_dump` (custom format, mode 600), 7 daily + 4 weekly |
| `deploy/restore.sh` | drill restore into a scratch DB; live restore only with `--force-live` |
| `deploy/seed-nginx.conf` | static `/seed` server with cache headers |
| `scripts/ci/check-prod-compose.mjs` | CI invariant checker for the rendered stack |

Hard rules baked into the files (CI-enforced, [verified in CI]):
- the compose project is named `huk`; its network is project-local — nothing is
  shared with other containers on the host;
- **no service publishes a port** except `web`, bound to
  `127.0.0.1:${HUK_WEB_PORT:-3100}`;
- no service runs `privileged`, shares `pid: host`, uses `network_mode: host`
  or mounts the Docker socket;
- dev defaults (`huk` Postgres password, dev salt, `mailpit`, `@example.com`,
  http/localhost URLs) cannot survive into a rendered stack.

### Coexistence with Rancher (your host already runs Rancher)

The station is designed to live next to Rancher, not inside it:

1. HUK publishes **one loopback port** (`127.0.0.1:3100`). It never touches
   80/443 — even if Rancher's ingress already holds them, there is no clash.
   All public traffic enters through the **outbound** tunnel; the host needs
   no new inbound ports at all.
2. Do **not** attach HUK containers to Rancher-created networks, do not mount
   Rancher volumes into HUK services, do not add HUK to a Rancher stack. The
   compose file defines its own project (`huk`) and network; leave it that way.
3. Keep Docker itself as the only root-privileged component; HUK containers
   run as the non-root user `bun` (uid 1000) inside their images [verified in
   the Dockerfile, H-108].
4. If you manage the host through the Rancher UI, that is fine — but deploy,
   update and back up HUK with the scripts in `deploy/`, not through Rancher
   workloads, so `docker compose -p huk ...` remains the single source of
   truth.

---

## 1. Preflight on the host (run these, paste the output into issue #89)

[not executed here] — the agent has no access to your server.

```bash
lsb_release -a
free -h
df -h / /var/lib/docker 2>/dev/null || df -h
docker --version && docker compose version
# what already runs there (Rancher and friends):
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
docker network ls
# port 3100 must be free; 80/443 may be taken by Rancher — that is fine:
ss -ltnp | grep -E ':(80|443|3100)\s' || echo "none of 80/443/3100 is listening"
```

Then the Docker Hub reachability probe (see §2) and one real pull:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull"
# 200 = Docker Hub reachable; 000 or timeout = go to §2.1 (ghcr fallback)
docker run --rm hello-world
```

Finally clone the repo (the deployment lives in `/srv/huk`):

```bash
sudo mkdir -p /srv/huk && sudo chown "$USER" /srv/huk
git clone https://github.com/ShkodnikAI/HUK.git /srv/huk
cd /srv/huk && git log -1 --format='%H %s'   # paste this into the issue too
```

Expectations: Docker ≥ 24 with compose v2, ~2 GB free RAM for the stack
(web 1g, worker 1.5g, postgres 1g, the rest small), port 3100 free.

---

## 2. Docker Hub access (images are pulled, never pushed)

HUK **pulls** five public images and pushes nothing:

| Image | Tag | Used by |
|---|---|---|
| `postgres` | `16` | runtime |
| `nginx` | `1.29-alpine` | runtime (`seed-audio`) |
| `cloudflare/cloudflared` | `2025.9.1` | runtime (tunnel profile) |
| `oven/bun` | `1` | Dockerfile build stage |
| `oven/bun` | `1-slim` | Dockerfile runtime stages |

All five tags were verified to exist on Docker Hub on 2026-10-16 via the Hub
API [verified]. They are also pinned in `deploy/docker-compose.prod.yml` and
`Dockerfile`, and the CI drill pulls them on every PR [verified in CI].

Docker Hub allows anonymous pulls (20/hour per IP). Register a **free account**
so you authenticate (180/hour) and the pulls are attributable:

1. Create the account at <https://hub.docker.com/signup> (any username).
2. Account Settings → Security → **Personal access tokens** → Generate new
   token → **Read-only** scope, description like `huk-server-readonly`.
   Read-only is enough: HUK never pushes.
3. On the server, log in once (the credential lives in
   `~/.docker/config.json`, base64-obfuscated — keep the server account
   itself locked down):
   [not executed here]
   ```bash
   docker login -u <your-username>
   # paste the PAT when asked (it starts with `dckr_pat_...`)
   ```

### 2.1 Fallback if Docker Hub is blocked from your host

If the §1 probe does not return `200` (some networks/registries are throttled
or blocked), the fallback is **ghcr.io**. This is a documented contingency,
not implemented code — do it only if the probe fails:

1. Verify the same tags exist on ghcr (they are official/first-party images
   mirrored on GHCR: `ghcr.io/cloudflare/cloudflared`, `ghcr.io/oven-sh/bun`;
   `postgres` and `nginx` official images are Docker-Hub-native — for them use
   `mirror.gcr.io/library/postgres:16` and `mirror.gcr.io/library/nginx:1.29-alpine`
   or a registry you control).
2. In CI (a small follow-up task, only when actually needed): a job that
   `docker pull`s the five images from their current sources and
   `docker push`es them retagged as `ghcr.io/shkodnikai/huk-<name>:<tag>`.
3. Switch `deploy/docker-compose.prod.yml` image lines (and the two `oven/bun`
   stages in `Dockerfile`) to the new references.

Until that is needed, change nothing.

---

## 3. Cloudflare: account, tunnel, hostnames

The Cloudflare account is the **single point of control** for the domain, the
DNS and the tunnel — protect it accordingly [not executed here]:

- enable **two-factor authentication** on the Cloudflare account (My Profile
  → Authentication);
- `hukradio.com` is already registered and its DNS is already on Cloudflare.

### 3.1 Create the named tunnel

[not executed here]

1. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel** → choose
   **Cloudflared** → name it `huk`.
2. Copy the token it offers (starts with `eyJ...`) — this goes into
   `deploy/.env` as `CLOUDFLARE_TUNNEL_TOKEN` (§5). No `cloudflared` login or
   `cert.pem` is needed with a token-run tunnel; the compose sidecar does it.
3. In the tunnel's **Public Hostname** tab add, **in this order** (first match
   wins):

   | Subdomain | Domain | Path | Service |
   |---|---|---|---|
   | (empty) | `hukradio.com` | `^/seed(/.*)?$` | `http://seed-audio:80` |
   | (empty) | `hukradio.com` | (empty) | `http://web:3000` |
   | `www` | `hukradio.com` | (empty) | `http://web:3000` |

   `web` and `seed-audio` are the compose service names on the internal
   network — the tunnel resolves them inside the `huk_internal` network, no
   host ports involved.
4. SSL/TLS: the tunnel terminates TLS at Cloudflare's edge; the origin leg is
   plain HTTP *inside* the tunnel — no origin certificate to install. If you
   also proxy other records, keep the zone SSL/TLS mode at **Full**.

### 3.2 www → apex redirect

[not executed here] Dashboard → **Rules → Redirect Rules → Create rule**:

- If: Hostname equals `www.hukradio.com`
- Then: **Dynamic** redirect, expression
  `concat("https://hukradio.com", http.request.uri.path)` → status **301**.

This is an edge redirect, exactly as decided in the issue — no application
code involved.

### 3.3 HSTS (note for later)

Application security headers (including `Strict-Transport-Security`) belong to
H-501, not to this card. When they land: start with a modest
`max-age=15552000` (6 months) and **without** `includeSubDomains`/`preload`;
after a full cycle without breakage, double the `max-age` and only then
consider adding subdomains. Do not enable HSTS at the Cloudflare edge for this
zone while www still serves anything.

---

## 4. SMTP for magic links (the only sign-in)

`EMAIL_SERVER` is required in production (S8, H-102): without a working SMTP
account **nobody can log in** — the stack boots, but sign-in mails will not
send. The provider is your choice; do not hard-code any. What must be true
for any provider [not executed here]:

1. Choose a provider with SMTP credentials (the runbook is
   provider-agnostic; any of the common transactional mail services works).
2. Create an SMTP credential and put it into `deploy/.env` as
   `EMAIL_SERVER="smtp://<user>:<password>@<smtp-host>:587"`.
3. Authenticate the sending domain at Cloudflare DNS — the provider gives you
   the exact values; add them as records on `hukradio.com`:
   - **SPF** — a `TXT` on the apex. There must be **exactly one** SPF record:
     if one already exists, merge the new `include:` into it instead of adding
     a second `v=spf1` record.
   - **DKIM** — the CNAME/TXT records the provider generates per sender
     domain; add them exactly as given.
   - **DMARC** — a `TXT` on `_dmarc.hukradio.com`, start strict-enough:
     `v=DMARC1; p=quarantine; adkim=s; aspf=s` (add `rua=` reporting once the
     inbound mailboxes below exist).
4. **Verify for real**: trigger a magic link to (a) a Gmail address and
   (b) an Outlook address. In Gmail: ⋮ → *Show original* — you want
   `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`. In Outlook: open the message →
   *View message source* — same three passes. If any is `FAIL`, fix the
   records before inviting anyone: without them magic links land in spam.
5. Inbound role mailboxes (`contact@`, `abuse@` — owner decision D6) are a
   separate Owner step, for example **Cloudflare Email Routing** with
   forwarding to your personal address. Describe-and-do: it does not block
   the beta, only set it up before public launch.

---

## 5. `deploy/.env` — the one file with secrets

[not executed here] On the server:

```bash
cd /srv/huk
cp deploy/.env.production.example deploy/.env
chmod 600 deploy/.env          # it must already be git-ignored; belt and braces
```

Fill every empty value. Generate the secrets locally (never reuse them):

```bash
openssl rand -base64 24   # POSTGRES_PASSWORD
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 24   # IP_HASH_SALT
```

Domain-tied values are already fixed by the example:
`NEXTAUTH_URL="https://hukradio.com"`, `EMAIL_FROM="HUK <no-reply@hukradio.com>"`,
`CLIENT_IP_HEADER="cf-connecting-ip"` (trustworthy only while the app is
reachable exclusively through Cloudflare — which the tunnel guarantees),
`SEED_AUDIO_BASE_URL="https://hukradio.com/seed"`.

Also set: `EMAIL_SERVER` (§4), `CLOUDFLARE_TUNNEL_TOKEN` (§3.1),
`HUK_BACKUP_DIR="/srv/huk-backups"`, and optionally
`INITIAL_ADMIN_EMAIL` (§7 — can also be added later and `web` restarted).

`deploy/check-env.sh` gates this file before anything starts [verified in CI —
12 test cases]: it refuses empty secrets, the dev Postgres password, the dev
salt, non-https or localhost/example.com URLs, `@example.com` senders, the
mailpit sink, relative backup dirs and placeholder tunnel tokens.

---

## 6. First start

**Start without the tunnel first** — the tunnel profile is off and no token is
needed beyond the env file [verified in CI, exactly this path]:

```bash
cd /srv/huk
sh deploy/up.sh --no-tunnel
```

What it does: `check-env` → builds web+worker images locally →
`docker compose up -d --wait` (postgres, web, worker, seed-audio) → waits for
`/api/health` to answer 200 on `127.0.0.1:3100`. Verify by hand [not executed
here]:

```bash
curl -s http://127.0.0.1:3100/api/health          # {"status":"ok",...}
docker compose -p huk -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
docker compose -p huk -f deploy/docker-compose.prod.yml --env-file deploy/.env logs web | tail
```

A migration ran automatically before the web start (the web container does
`prisma migrate deploy`; the worker never migrates). Check:

```bash
docker compose -p huk -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  exec -T postgres psql -U huk -d huk -At -c 'SELECT count(*) FROM _prisma_migrations'
```

Then the real start with the tunnel (profile `tunnel` starts `cloudflared`
with your token) [not executed here]:

```bash
sh deploy/up.sh
```

From an outside network check <https://hukradio.com/api/health> and that
<https://www.hukradio.com> 301-redirects to the apex. This completes the
deployment.

---

## 7. First admin bootstrap

If `INITIAL_ADMIN_EMAIL` was set in `deploy/.env` before the first start:
sign in once with **that exact email** (magic link via §4 SMTP). The first
verified sign-in with that email becomes ADMIN while no ADMIN exists (H-102).
[not executed here]

Leaving it empty is safe: the stack boots with a disabled placeholder
(`disabled@bootstrap.invalid`) that no real sign-in can match — the bootstrap
stays off until you set a real address. `deploy/check-env.sh` prints a NOTE
(not an error) in that case.

If it was not set: add it to `deploy/.env`, then `sh deploy/up.sh` (restarts
web with the new env) and sign in. Until an ADMIN exists the bootstrap stays
armed; after it, the variable is inert and can stay or be emptied.

---

## 8. Seed audio in production

Seed tracks are procedurally generated (no copyright, no audio in git — D7)
and served by the `seed-audio` nginx container from the `seed_audio` volume,
reached only through the tunnel (`hukradio.com/seed*`, cache headers in
`deploy/seed-nginx.conf`).

On the host [not executed here]:

```bash
# 1. Generate (deterministic; needs python3.11+, numpy/scipy, ffmpeg):
pip install -r /srv/huk/scripts/seed-content/requirements.txt
python3 /srv/huk/scripts/seed-content/make_seed.py --out /srv/huk-seed

# 2. Copy the files into the huk_seed_audio volume (the compose project
#    creates it on first `up`; this is a one-off):
docker run --rm -v huk_seed_audio:/dst -v /srv/huk-seed:/src:ro \
  alpine sh -c 'cp -a /src/. /dst/'

# 3. Register them as SEED tracks (one-shot, idempotent — safe to re-run):
docker compose -p huk -f /srv/huk/deploy/docker-compose.prod.yml \
  --env-file /srv/huk/deploy/.env --profile seed run --rm seed-register
```

`seed-register` uses the worker image (it has `ffprobe` for durations),
upserts by file name (externalId) and needs no manual data. Verify:
`curl -sI https://hukradio.com/seed/manifest.json` → 200 with
`Cache-Control: public, max-age=86400`, and the tracks appear in the radio
rotation.

---

## 9. Backups and the restore drill

`deploy/backup.sh` dumps with `pg_dump -Fc` into `$HUK_BACKUP_DIR/daily`
(mode 600, verified with `pg_restore --list`), keeps 7 daily + 4 weekly
copies. Schedule it [not executed here]:

```bash
crontab -e
# nightly 04:10 UTC:
10 4 * * * /srv/huk/deploy/backup.sh >> /var/log/huk-backup.log 2>&1
```

**Restore drill** (do it once after first deploy, then quarterly) — the exact
sequence CI runs [verified in CI; on the host not executed here]:

```bash
# make a known change, then back up:
docker compose -p huk -f /srv/huk/deploy/docker-compose.prod.yml --env-file /srv/huk/deploy/.env \
  exec -T postgres psql -U huk -d huk -c \
  "CREATE TABLE IF NOT EXISTS drill_marker (id int PRIMARY KEY, note text);
   INSERT INTO drill_marker VALUES (42, 'drill-<today>')"
sh /srv/huk/deploy/backup.sh /srv/huk/deploy/.env
# restore the newest dump into a SCRATCH database (live DB untouched):
sh /srv/huk/deploy/restore.sh /srv/huk-backups/daily/<newest>.dump /srv/huk/deploy/.env
```

`restore.sh` prints per-table row counts of the scratch DB
(`huk_restore_<timestamp>`). Compare with the live database; the `drill_marker`
row must be there. A restore **over** the live database exists but is
explicitly destructive: `deploy/restore.sh <dump> --force-live`.

---

## 10. Update and rollback

To roll the station to a repo state [not executed here; the machinery is
verified in CI]:

```bash
cd /srv/huk && git pull
sh deploy/update.sh <git-ref>        # e.g. the new main SHA or a tag
```

`update.sh` builds both images from that ref in a throw-away worktree
(the running stack is untouched while building), switches the stack over,
and checks health. If the new images fail their healthcheck or
`/api/health` does not return 200, it **automatically redeploys the previous
tag** and exits 1. [verified in CI — a deliberately broken image is rolled
back and the stack returns healthy.]

Manual fallback to the previous tag (only if the automatic path died):
`sh deploy/update.sh <previous-tag>`.

---

## 11. Kill switch — take the site offline in one command

[not executed here on the host; the stop/start recovery path is verified in CI]

```bash
cd /srv/huk
# OFFLINE (public site + seed audio + tunnel edge):
docker compose -p huk -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  stop web seed-audio cloudflared
# verify: https://hukradio.com must stop answering; then:
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3100/api/health

# BACK ONLINE:
docker compose -p huk -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  start web seed-audio cloudflared
```

Postgres and worker keep running either way — data and scheduled work are not
affected by the switch; only the public surface goes dark. If you also want
the background jobs stopped, add `worker` to both commands.

---

## 12. Isolation rules (the neighbour project on this host)

The station must never disturb (or be disturbed by) whatever else runs on the
server — including Rancher:

1. **Networks**: `deploy/docker-compose.prod.yml` declares one project-local
   network (`huk_internal`). Never attach it to another compose project, a
   Rancher-managed network or `network_mode: host` (CI fails the PR if any of
   this appears — [verified in CI]).
2. **Volumes**: HUK uses exactly `pgdata`, `audio_cache`, `seed_audio`
   (all prefixed by the compose project). Never mount another project's
   volumes, and never give other projects access to HUK's.
3. **Ports**: the only published port is `127.0.0.1:3100`. Nothing else
   listens on the host. Postgres is reachable only inside the internal
   network.
4. **Privileges**: no container runs `privileged`, no `pid: host`, no Docker
   socket mounts (CI-checked). The images themselves drop to the non-root
   `bun` user (uid 1000) [verified in the Dockerfile and by CI].
5. **Secrets**: `deploy/.env` is mode 600 and git-ignored; the CI drill uses
   throw-away secrets and never commits any. Rotate `AUTH_SECRET` /
   `POSTGRES_PASSWORD` by regenerating and restarting; rotating invalidates
   sessions (acceptable — it is a kill-the-session rotation).
6. **Root on the host**: only Docker itself needs root; run the deploy
   scripts as a user in the `docker` group, not as root. The nightly backup
   writes files with mode 600 owned by that user.

---

## 13. Open questions (tracked, not solved here)

1. **Cloudflare free plan and self-hosted audio** — serving seed audio from
   our own origin through the Cloudflare free proxy must be checked against
   Cloudflare's terms (unlimited free bandwidth is conditional; audio/video
   distribution has historically been a sensitive use). **Before public
   launch**, not blocking the closed beta. Owner action.
2. **SMTP provider choice** — Owner decision (§4); the runbook is
   provider-agnostic by design.
3. **Rented VPS (D4)** — deferred; these exact files are meant to be reused
   there unchanged (host paths in this runbook assume `/srv/huk` but nothing
   depends on it).
4. **Inbound role mailboxes** (`contact@`, `abuse@`, D6) — Owner step via
   Cloudflare Email Routing or the mail provider; describe in §4, automate
   never.
