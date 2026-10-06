# HUK — Architecture (v2)

Status: design baseline, supersedes prototype v0.2.1. Changes to this document
that alter a decision need an ADR (`docs/adr/`).

## 1. Principles

1. **Authors keep their files.** We store metadata, hashes and links, not user audio.
2. **One shared timeline.** Everyone hears the same moment; the server is the only clock.
3. **Deterministic rankings, AI as auditor.** Charts are pure functions of events; AI flags abuse and reviews content.
4. **Cheap by default.** One small server, free tiers, hard daily cost caps. Growth is gated by budget, not hope.
5. **Fail closed, fail loud.** Doubt → human review; refusal → typed error + audit record.
6. **Minimal data about people.** Hashed IPs, retention jobs, no trackers.

## 2. System overview

```
 Browser / PWA (Next.js, next-intl)           Cloudflare (free): CDN, DDoS, rate limit,
 ┌───────────────────────────────┐            cache GET /api/radio/now for 2–3 s
 │ persistent player (root layout)│──────────▶ ┌──────────────────────────────────┐
 │ modes: Radio | My playlist     │            │ web (Next.js route handlers)      │
 │ Media Session, i18n (EN default)│           │  auth (Auth.js), guard, zod, rate │
 └───────────────┬────────────────┘            │  limit, read APIs, write APIs     │
                 │ audio streams directly       └───────────────┬──────────────────┘
                 ▼                                              │ SQL
   Audius / author-hosted URLs                      ┌───────────▼───────────┐
   (never through our server)                       │ PostgreSQL            │
                                                    └───────────▲───────────┘
 ┌──────────────────────────────────────────────┐               │
 │ worker (single instance, pg advisory lock)    │───────────────┘
 │  • broadcast scheduler (timeline)             │
 │  • moderation pipeline consumer               │──▶ AcoustID / AudD, ASR, LLM
 │  • link re-verification (hash/ETag)           │    (all behind adapters + budget.guard)
 │  • chart + score jobs, retention jobs         │
 └──────────────────────────────────────────────┘
```

Phase-1 stack: Docker Compose on one VPS (`web`, `worker`, `postgres`). Redis is
added only when charts/listener counts need it (M scale). See ADR-0005.

## 3. Repository layout

```
.github/                 templates, CODEOWNERS, workflows
docs/                    ARCHITECTURE, PLAN, AUDIT, LEGAL, OWNER_DECISIONS, adr/, audits/
policy/                  moderation-policy.md (versioned, read by the pipeline)
messages/                en.json (source), ru.json, ...
prisma/                  schema.prisma, migrations/, seed.ts
scripts/ci/              invariant checks (route-auth, no-raw-fetch, docs-language, ...)
scripts/                 seed-content (procedural music), cleanup, ops helpers
src/app/                 Next.js App Router
  [locale]/              pages: radio, charts, artists, tracks, playlists, search, legal
  api/                   route handlers (thin: parse → guard → service → respond)
src/server/              all business logic, framework-free where possible
  guard.ts               requireUser / requireRole / rate limits
  env.ts                 zod-validated environment
  net/safe-fetch.ts      the only outbound HTTP door for user URLs (S4)
  budget.ts              budget.guard() cost fuse (S6)
  audit.ts               AuditLog writer
  broadcast/             timeline math + scheduler (pure functions + worker entry)
  sources/               providers: audius.ts, direct-url.ts, verify.ts
  moderation/            pipeline, stages, adapters (asr/fingerprint/llm), policy loader
  ranking/               signals, wilson, decay, exploration, antifraud, charts
  reports/               triage, takedown, region restrictions
  comments/ playlists/ reactions/ taxonomy/ artists/
src/worker/index.ts      worker entry (scheduler + queues)
src/components/          UI (shadcn kit), player/, charts/, cabinet/
src/lib/                 client helpers (sync clock, i18n helpers)
tests/                   unit (vitest), api, e2e (playwright, later)
```

Rule: route handlers contain no business logic; services in `src/server/` are
unit-testable without HTTP.

## 4. Data model (see `prisma/schema.prisma`)

Core entities: `User` (role), `ArtistProfile`, `Track`, `TrackSource`,
`TaxonomyTerm`/`TrackTerm`, `Consent`, `ModerationRun`, `BroadcastSlot`,
`StationState`, `Reaction`, `ListenEvent`, `TrackScore`, `ChartSnapshot`,
`Playlist`/`PlaylistItem`, `Comment`, `Report`, `RegionRestriction`, `AuditLog`,
`BudgetLedger`.

Retention (enforced by worker jobs, configurable by env):

| Data | Default retention |
|---|---|
| `ListenEvent` raw rows | 90 days, then aggregates only |
| Transcripts in `ModerationRun.payload` | 90 days |
| IP hashes (rotating salt) | 24 h salt rotation; no raw IP stored |
| `AuditLog`, `Report` | 24 months |
| Deleted account | profile erased; comments anonymised ("deleted user") |

## 5. Broadcast timeline

- `BroadcastSlot(seq, trackId, startsAt, endsAt)` is the schedule. Only the
  worker writes it (single writer via `pg_try_advisory_lock`).
- The scheduler keeps the next N slots filled. Each slot picks a track by
  quota: ~40% top-ranked, ~40% fresh (exploration), ~20% rest (tunable).
  Never repeats a track within a configurable window; never schedules a track
  that is not `APPROVED` and `available`.
- `GET /api/radio/now` is a **pure read** returning `{serverTime, current,
  next[]}`; identical for all listeners, so Cloudflare caches it 2–3 s.
- Client: `skew = serverTime − Date.now()`, seeks to the expected offset, corrects
  drift > 3 s, re-syncs on `visibilitychange`. Playback must survive screen lock
  (Media Session API, single `<audio>` element in the root layout).
- A track disappearing mid-air (takedown/unavailable) ends its slot early and the
  scheduler fills the gap; the timeline never has holes.

## 6. Track sources

`TrackSource.provider ∈ {AUDIUS, DIRECT_URL, SEED}`.

- **AUDIUS:** resolve through the Audius API (key in env). Terms regarding AI
  music and radio-style use must be verified before launch (OWNER_DECISIONS D3).
- **DIRECT_URL:** author supplies an HTTPS URL to a file they host. Fetched only
  via `safe-fetch` for moderation (transient), then `contentHash`, `etag`,
  `byteLength` are stored. A re-verification job compares ETag/length (and a
  full hash on a schedule); mismatch → track suspended and re-moderated.
- **SEED:** procedural music generated by `scripts/seed-content`, hosted by us.
- Clients stream from the source directly. If the source is unreachable the slot
  is skipped and `failCount` increments; repeated failure marks the track
  `available=false`.

## 7. Submission and moderation pipeline

Submission (artist role required): declarations (rights, AI tool, plan at time
of creation, human contribution, language, instrumental), license scope
(`RADIO_ONLY` or `RADIO_AND_PLAYLISTS`), consent to the current ToS version
(`Consent` row with version + time + IP hash). Quotas: per author per day, and a
platform-wide daily cap (cost fuse). Invite-only mode toggle for beta.

Cascade (cheap first; each stage writes a `ModerationRun`):

| # | Stage | Purpose | Provider |
|---|---|---|---|
| 0 | Declaration gate | required fields, link policy | internal |
| 1 | Technical | ffprobe, duration 15 s–12 min, silence | internal (ffmpeg) |
| 2 | Fingerprint | known-recording match | AcoustID (free) → AudD (later) |
| 3 | ASR | language ID + transcript of several segments, only if vocals | gpt-4o-mini-transcribe or equal |
| 4 | Policy verdict | `APPROVE/REJECT/REVIEW` + confidence | LLM, multilingual, schema-validated |
| 5 | Human | all REVIEW and all low-confidence | moderator console |

Rules: AUTO decisions need confidence ≥ 0.75 (tunable); any adapter error,
budget stop, schema failure or timeout ⇒ `REVIEW`. Prompt injection hardening:
untrusted fields are passed as delimited data, the policy text is a separate
system block loaded from `policy/moderation-policy.md`, output is JSON-schema
validated, and no instruction in data can change the verdict format.
The verdict never auto-approves when fingerprint returned a strong match.

Comments, playlist names/descriptions, artist bios and links run through a
lighter text check (OpenAI moderation endpoint or the same LLM stage). New
accounts: held until checked; established accounts: publish then post-check.

## 8. Reports, takedown, regional restriction

`Report` (target: track/comment/playlist/user) → AI triage (category, urgency,
duplicate grouping) → human decision for anything legal, any ban, any appeal.
Obvious cases (strong fingerprint match, clear policy violation) may be
actioned automatically but always logged and reversible. Removal records a
statement of reasons visible to the affected author. `RegionRestriction(track,
country)` hides a track in one country without removing it globally; used for
legal orders. Contact address and a DMCA agent designation are launch gates.

## 9. Reactions, listen events and rankings

Signals per (user, track): `LIKE` (public count), `DISLIKE` (never shown,
used only internally), playlist-add (strong +), completion ratio, repeat plays,
early skip in playlist mode (−). A vote or comment is accepted only after ≥ 30 s
of server-verified listening.

Score (pure functions in `src/server/ranking/`):
1. weight each event: base(type) × user reputation × `exp(−ln2·age/halfLife)`,
   half-life 7 days for the weekly chart;
2. sum weighted positives P and negatives N; `p̂ = P/(P+N)`, `n = P+N`;
3. `score = wilsonLowerBound(p̂, n, z=1.96)` (continuity-corrected for small n);
4. entry threshold: ≥ 10 distinct voters in the window;
5. exploration for fresh tracks: Beta(likes+1, dislikes+1) Thompson sampling to
   allocate the "fresh" scheduler quota (not used for chart order).
Anti-fraud v1: reputation by account age, per-account/IP-hash limits, burst
and ring detection (many new accounts, same ASN/time window); flagged votes
get weight 0 and an audit entry. **Dislikes never auto-remove a track.**

Charts: top-100 per category key (`lang`, `style`, `direction`, `instrumental`,
and combinations with enough tracks, ≥ 20). A weekly `ChartSnapshot` is stored
each Monday 00:00 UTC. A public "How charts work" page describes the signals.
Personalised recommendations (Gorse) and audio embeddings are phase 6.

## 10. Public API surface (all inputs zod-validated, all errors typed)

| Route | Method | Auth |
|---|---|---|
| `/api/radio/now` | GET | public (cacheable) |
| `/api/radio/listen` (heartbeat, batched) | POST | public (anon id, rate limited) — in `public-routes.txt` |
| `/api/tracks`, `/api/tracks/:id` | GET | public (APPROVED only) |
| `/api/tracks` | POST | artist |
| `/api/tracks/:id/source/verify` | POST | artist (own) / worker |
| `/api/reactions` | POST/DELETE | user (≥30 s listened) |
| `/api/playlists*` | all | user (own); public read for PUBLIC |
| `/api/comments*` | POST/DELETE | user; moderation actions: moderator |
| `/api/reports` | POST | user (anon allowed for legal contact form, rate limited) |
| `/api/charts/:category` | GET | public (cacheable) |
| `/api/mod/*` | all | moderator/admin |
| `/api/admin/*` | all | admin |

There is no query parameter, header or route that serves non-approved tracks.

## 11. Cost and operations

Targets: S ≈ $12–20/month; M ≈ $160–280; L ≈ $650–1,200 (driven by moderation of
new tracks, ~$0.03–0.05 per track). Controls: invite-only beta, per-author and
platform daily caps, cascade ordering, trusted-author lighter checks, `budget.guard()`
with a daily ledger and an alert when 80% is spent. Observability: structured logs,
`/api/health`, uptime ping, error tracking (free tier), daily spend report.
Backups: nightly `pg_dump` off-box, quarterly restore drill.

## 12. Out of scope (deliberate)

User audio hosting, ads, payouts, voice/DJ, DMs, live ingest (Icecast), native
apps (phase 6 wrapper only), recommendation ML before enough data.
