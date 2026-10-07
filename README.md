<p align="center">
  <img src="docs/assets/brand/huk-banner.svg" alt="HUK wordmark: the letter H carries an audio waveform as its crossbar" width="720">
</p>

# HUK

A free, non-commercial, international 24/7 internet radio for music that authors publish
themselves — with AI-assisted moderation and transparent, deterministic charts.

> **Status: pre-alpha (v2 rewrite).** The earlier prototype is preserved at the git tag
> `prototype-v0.2.1` and must not be deployed.

## What it is
- One shared timeline: everyone hears the same moment. Plays on a locked screen (PWA).
- Authors keep their files. HUK links to them (Audius or author-hosted URLs) and stores only metadata and hashes.
- Listeners like tracks (public) and dislike privately (ranking signal only), build personal playlists, comment.
- Weekly top-100 charts by language, style, direction, and instrumental.
- Moderation targets blatant crime and nastiness only; AI triages, humans decide the hard cases.
- No ads. No payouts. Donations (if any) support the software developer, not the station.

## How the project is run
| File | Purpose |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Method for the coding agent: roles, security invariants, what "done" means |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | System design |
| [`docs/PLAN.md`](docs/PLAN.md) | Waves and naryads (work orders) |
| [`docs/AUDIT.md`](docs/AUDIT.md) | How work is verified |
| [`docs/BRAND.md`](docs/BRAND.md) | Logo, colours, typography, usage rules |
| [`docs/OWNER_DECISIONS.md`](docs/OWNER_DECISIONS.md) | Open decisions that block work |
| [`docs/LEGAL.md`](docs/LEGAL.md) | Legal assumptions and questions for counsel |
| [`docs/adr/`](docs/adr/) | Architecture decision records |
| [`policy/moderation-policy.md`](policy/moderation-policy.md) | What is and is not allowed |

## Stack
Next.js 16 (App Router) · TypeScript (strict) · Tailwind 4 + shadcn/ui tokens · zod-validated env ·
PostgreSQL 16 + Prisma 6 (migrations only, no `db push`) · Vitest · ESLint · bun · a single worker
process (src/worker) · Docker Compose (`web`, `worker`, `postgres:16`) on one VPS behind Cloudflare.
The `web` and `worker` containers run as the non-root user `bun` (uid 1000, H-108).
`next-intl` and Auth.js arrive with H-105/H-102 respectively.

## Seed content

The station ships with procedurally generated seed tracks (no copyright, no
audio in git — `*.mp3` is ignored):

```bash
pip install -r scripts/seed-content/requirements.txt
python3 scripts/seed-content/make_seed.py --out public/seed   # deterministic; byte-identical reruns
bun run seed:tracks public/seed                               # registers them as SEED tracks (idempotent)
```

`make_seed.py` writes `manifest.json` next to the audio; `seed:tracks` measures
duration with ffprobe (part of ffmpeg), computes sha256/size, and upserts the
tracks (status `APPROVED`, provider `SEED`). Requires ffmpeg ≥ 4. Python 3.11+
with `numpy`/`scipy`.

## Configuration

Environment is validated at boot (`src/server/env.ts`, S8); see `.env.example`.
Magic links are built on `NEXTAUTH_URL` only (H-110): next-auth v4 ignores
`AUTH_URL`, and `AUTH_TRUST_HOST` must stay unset — deriving the origin from
forwarded headers would allow link poisoning. In production `NEXTAUTH_URL`
must be an `https://` URL or the server refuses to start.

## Running with Docker Compose

```bash
cp .env.example .env                # then: AUTH_SECRET="$(openssl rand -base64 32)" >> .env
docker compose up --build           # web :3000, worker, postgres, mailpit :8025
```

`docker compose up` boots the whole station locally: web (migrations run first), the
worker, `postgres:16`, and a `mailpit` SMTP sink — magic links land in its UI at
<http://localhost:8025>. The compose file injects development defaults for
`IP_HASH_SALT`, `CLIENT_IP_HEADER`, `EMAIL_SERVER` and `NEXTAUTH_URL` (override them in
`.env`); `AUTH_SECRET` stays mandatory. Production deployments must set real values in
their own environment — the dev defaults must never reach production (S8 fails loud at
boot otherwise). CI proves the stack on every PR and on `main` with the `docker-smoke`
job (images build, both containers run as non-root, `/api/health` and `/api/radio/now`
answer 200, the worker stops cleanly on SIGTERM).

## Contributing
Work happens through naryads: open an issue from the *Naryad* template that references a card in
`docs/PLAN.md`, branch, open a PR, pass CI. See `AGENTS.md`.

## License
Code: CC0-1.0 (see `LICENSE`). Owner decision D8/D9 may revisit naming and licensing before launch.
