# HUK — Implementation plan

Method: waves of naryads (work orders). One naryad = one issue = one branch = one PR.
Numbering `H-<wave><nn>`. Priorities: P0 blocks everything after it, P1 core product,
P2 later. Classes: `[core] [security] [process] [docs] [bugfix] [feature]`.
`OD` = contains an owner decision point (must be decided in the issue before work starts).
Every card inherits the contract in `AGENTS.md` §6 and the audit in `docs/AUDIT.md`.

Gates between waves are audited by the Auditor after the merges and recorded in `docs/audits/`; the next wave is
published only after the record is on `main`. Where a published issue differs from its card below, the issue wins.

## Index of published naryads (maintained by the Auditor; source of truth for publishing)

| Card | Issue | Wave | State (2026-10-07, after gate W1) |
|---|---|---|---|
| H-001 | #2 | W0 | merged (PR #12) |
| H-002 | #3 | W0 | merged (PR #15; record corrected in PR #20) |
| H-003 | #4 | W0 | merged (PR #14) |
| H-107 | #16 | W0 follow-up | merged (PR #19) |
| H-108 | #21 | W1 follow-up | merged (PR #30; Docker evidence still open, see H-111) |
| H-109 | #22 | W1 follow-up | merged (PR #32) |
| H-101 | #23 | W1 | merged (PR #33) |
| H-103 | #24 | W1 | merged (PR #35) |
| H-102 | #25 | W1 | merged (PR #39) |
| H-104 | #26 | W1 | merged (PR #36, fix #37) |
| H-105 | #27 | W1 | merged (PR #40) |
| H-106 | #28 | W1 | merged (PR #38) |
| H-110 | #42 | W2 | open |
| H-111 | #43 | W2 | open |
| H-201 | #44 | W2 | open |
| H-209 | #45 | W2 | open |
| H-202 | #46 | W2 | open |
| H-203 | #47 | W2 | open |
| H-204 | #48 | W2 | open |
| H-205 | #49 | W2 | open |
| H-206 | #50 | W2 | open |
| H-207 | #51 | W2 | open |
| H-208 | #52 | W2 | open |
| H-210 | #53 | W2 | open |

---

## W0 — Reset and guardrails (P0)

**H-001 — Finish the reset.** `[process]` `OD` (D7 decided: prototype restored as the tag `prototype-v0.2.1`, option b)
Scope: `legacy/` holds the four prototype reference files, restored by the Owner (commit
`9032361`; `use-radio.ts`, `visualizer.tsx`, `gen_music.py` byte-identical to `24d0c33`,
`technical-check.ts` the hand-finalised extraction) for porting in W1–W2; the tag is pushed
to origin (audio/SQLite reachable only via the tag); retire `scripts/cleanup-w0.sh`
(obsolete — `main` was already cleaned by the Owner).
Done: `git ls-files` has no `scripts/cleanup-w0.sh`, no binary > 1 MB and no `*.db`; `legacy/` contains exactly the four files + `README.md`; CI "large-files" job green.

**H-002 — Governance and CI skeleton.** `[process]` (this package)
Scope: `AGENTS.md`, `CLAUDE.md`, `.github/**`, `docs/**`, `policy/**`, `scripts/ci/**`, `.gitleaks.toml`.
Done: workflows run on a PR; `route-auth-guard` and `docs-language` pass on the skeleton; CODEOWNERS covers `.github/` and `scripts/ci/`.

**H-003 — Application scaffold.** `[core]` deps H-002
Scope: Next.js 16 App Router, TypeScript strict, Tailwind + shadcn, ESLint, Vitest, `bun`, `src/server/env.ts`
(zod, fails at boot), Docker Compose (`web`, `worker`, `postgres`), `/api/health`.
Done: `bun run lint && bun run typecheck && bun run test && bun run build` green; `docker compose up` serves `/api/health`; no secrets in repo.

Gate W0→W1: Owner merges H-001..H-003.

---

## W1 — Foundation (P0)

**H-101 — Data model v2 and migrations.** `[core]` deps H-003
Scope: `prisma/schema.prisma` (draft provided), real migrations (`prisma migrate`), seed skeleton; remove any `db push` from scripts.
Done: `prisma validate` and `migrate deploy` on a clean Postgres in CI; seed idempotent; schema review by Auditor.

**H-102 — Authentication and roles.** `[security]` deps H-101
Scope: Auth.js with email magic link (+ optional OAuth), roles `LISTENER/ARTIST/MODERATOR/ADMIN`, `src/server/guard.ts`
(`requireUser`, `requireRole`), session cookies (httpOnly, sameSite), CSRF for cookie-auth mutations.
Done: authorization matrix test (every role × every protected route → expected 200/401/403); no route trusts client-sent identity.

**H-103 — Request pipeline: validation, rate limits, errors.** `[core]` deps H-102
Scope: zod request parsing helper, typed error responses, rate limiter (Postgres-backed, per account and per IP hash), `AuditLog` writer, IP hashing with rotating salt.
Done: unit tests; limiter returns 429 with `Retry-After`; no raw IP persisted (test greps schema and logs).

**H-104 — Broadcast scheduler (worker).** `[core]` deps H-101
Scope: `src/server/broadcast/` pure timeline math, `src/worker/index.ts` with advisory-lock single writer, `BroadcastSlot` filling with the 40/40/20 quota, no-repeat window, early-end on takedown; `GET /api/radio/now` pure read.
Done: property tests for timeline continuity (no gaps/overlaps), restart-safe, two workers started → exactly one writes; `/now` makes ≤ 2 queries and is cache-safe.

**H-105 — Player shell, sync, PWA, i18n scaffold.** `[feature]` deps H-104
Scope: root-layout persistent player (port `legacy/use-radio.ts` sync logic), Media Session API, `visibilitychange` resync, mode switch Radio/My playlist (stub), PWA manifest, `next-intl` with `en` source + `ru`, locale routing.
Done: manual checklist (screen lock on Android/iOS Safari documented in the PR), unit tests for skew/drift math, no hard-coded UI strings (lint rule).

**H-106 — Seed content pipeline.** `[core]` deps H-101
Scope: port procedural generator to `scripts/seed-content`, output to an ignored dir, upload step for object storage/dev dir, idempotent seed registers `SEED` tracks.
Done: no audio committed; `bun run seed:content` produces ≥ 9 tracks; scheduler plays them locally.

**H-108 — Non-root containers.** `[security]` Issue #21. Finding F3 of gate W0.

**H-109 — AST-based environment guard and edge-runtime check.** `[security]` Issue #22. Findings N1, N2 of gate W0.

Gate W1→W2: Auditor security review of H-102/H-103 (authorization matrix, rate limits).

---

## W2 — Sources and moderation (P0)

**H-201 — Safe outbound fetch.** `[security]` deps H-103
Scope: `src/server/net/safe-fetch.ts`: https only (http allowed in dev flag), resolve DNS then block private/loopback/link-local/metadata ranges, re-validate every redirect, max size/time, content-type sniffing, no cookies/credentials.
Done: tests for SSRF classes (IPv4/IPv6 private, DNS rebinding simulation, redirect to internal, decimal/hex IPs); CI job `no-raw-fetch` forbids `fetch(`/`axios` on user URLs outside this file.

**H-202 — Track source providers and verification.** `[core]` deps H-201
Scope: `sources/audius.ts`, `sources/direct-url.ts`, `sources/verify.ts`; store `contentHash/etag/byteLength`; re-verification job; availability tracking.
Done: contract tests with a local fake host; hash mismatch → track suspended + re-moderation queued; Audius calls mocked in tests.

**H-203 — Submission flow and declarations.** `[feature]` deps H-102, H-202
Scope: artist submission API/UI: declarations (rights, AI tool/plan, human contribution, language, instrumental), license scope, consent rows, quotas, invite-only toggle, platform daily cap.
Done: cannot submit without current-ToS consent; quotas enforced; non-Latin titles accepted; tests for each rejection path.

**H-204 — Moderation pipeline core and adapters.** `[core]` deps H-203, H-103
Scope: `src/server/moderation/` stages 0–5 behind adapter interfaces (`FingerprintAdapter`, `AsrAdapter`, `LlmAdapter`), `budget.guard()` (S6), policy loader for `policy/moderation-policy.md`, schema-validated verdicts, fail-closed to REVIEW, `ModerationRun` audit rows.
Done: golden tests with mocked adapters (clean, violation, injection attempt in title/transcript, adapter timeout, budget exhausted, strong fingerprint match) all end in the expected state; injection fixtures never change the output format.

**H-205 — Fingerprint adapters.** `[core]` deps H-204 `OD` (AcoustID is free for non-commercial use; confirm donation model fits — see OWNER_DECISIONS D5)
Scope: Chromaprint (`fpcalc`) + AcoustID adapter; AudD adapter behind a flag.
Done: adapter tests with recorded responses; strong match prevents auto-approve.

**H-206 — Reports, takedown, regional restriction.** `[core]` deps H-204
Scope: report API, AI triage, human actions, statement of reasons, `RegionRestriction`, contact form, takedown that also ends the live slot early.
Done: takedown of the currently playing track ends it within one scheduler tick; region-restricted track not served to that country (country from Cloudflare header, tested with fixtures).

**H-207 — Moderator console.** `[feature]` deps H-204, H-206
Scope: queue UI with transcript, AI rationale, audit trail, approve/reject/restrict, role-guarded.
Done: only MODERATOR/ADMIN reach it; every action writes `AuditLog`.

**Added at gate W1** (see `docs/audits/2026-10-07-gate-W1.md`):

**H-110 — W1 hardening.** `[security]` Issue #42. Findings F1-F4, F6-F8, F12 (next-auth base URL, limiter parity, /now filter, bounded body, Origin check). Runs first.

**H-111 — Compose usable again + Docker smoke job in CI.** `[core]` Issue #43. Finding F5.

**H-208 — ASR and LLM adapters.** `[core]` `OD` Issue #52. Providers, spend cap and policy approval (D2) are Owner decisions.

**H-209 — Invites and artist onboarding.** `[feature]` Issue #45.

**H-210 — Worker maintenance jobs (retention, S7).** `[security]` Issue #53.

Gate W2→W3: Auditor red-team pass (moderation bypass, SSRF, injection, budget exhaustion). Owner decisions D3 (Audius terms) and D2 (link policy) closed.

---

## W3 — Social layer (P1)

**H-301 — Listen events and reactions.** `[feature]` deps H-104
Scope: batched listen heartbeat, server-side verified listening, LIKE (public) / DISLIKE (hidden), one effective reaction per user per track, retention job.
Done: reaction rejected before 30 s verified listening; dislike never present in any public payload (contract test over all GET routes).

**H-302 — Personal playlists.** `[feature]` deps H-102, H-105
Scope: local-first guest playlists synced on login, limits (50 playlists × 500 tracks), visibility, unavailable-track handling, My-playlist playback mode honoring `licenseScope`.
Done: tracks with `RADIO_ONLY` cannot be added or played from playlists; removed tracks shown as unavailable; tests.

**H-303 — Comments.** `[feature]` deps H-204, H-301
Scope: comments with the rules in ARCHITECTURE §7, held-until-checked for new accounts, report button, author can hide, anonymisation on account deletion.
Done: link/length/rate rules tested; text-moderation adapter mocked; hide/remove produce audit rows.

**H-304 — Ranking engine.** `[core]` deps H-301
Scope: `src/server/ranking/` pure functions (weights, Wilson, decay, exploration), anti-fraud v1, `TrackScore` job.
Done: unit tests incl. the 5/5 vs 199/200 case, decay monotonicity, burst-vote discount; deterministic given fixed inputs; the "How charts work" text drafted.

**H-305 — Charts API and UI.** `[feature]` deps H-304, H-402
Scope: top-100 per category with thresholds, weekly snapshot job, scheduler quota integration (40/40/20).
Done: snapshot idempotent; categories under 20 tracks collapse to parent; cacheable GETs.

---

## W4 — Artists and taxonomy (P1)

**H-401 — Artist cabinet.** `[feature]` deps H-203
Scope: profile, own tracks with status, stats, playlists, outbound links (whitelist + `rel="nofollow ugc noopener"` + interstitial) `OD` (link policy D2).
Done: only whitelisted domains accepted; edits audited.

**H-402 — Taxonomy.** `[feature]` deps H-204
Scope: controlled vocabulary (language, style, direction, instrumental), AI suggestion at moderation, author confirmation, category pages.
Done: free-text tags impossible; suggestion stored separately from confirmed values.

**H-403 — Search.** `[feature]` deps H-402
Scope: Postgres full-text (multilingual `simple` config + trigram) over title/artist/terms.
Done: p95 < 200 ms on 10k tracks fixture; only APPROVED & available returned.

**H-404 — Legal pages and consent plumbing.** `[docs]` `OD` blocked on lawyer review (D1)
Scope: ToS, Privacy, Takedown/Contact, About/Support (donation link), versioning wired to `Consent`.
Done: ToS version bump forces re-consent before next submission; texts approved by Owner after legal review.

---

## W5 — Hardening and launch (P0 before public)

**H-501 — Security review wave.** `[security]` Auditor-led
Scope: full authorization matrix, SSRF suite, CSP/headers, rate-limit bypass attempts, dependency audit, secret scan, injection corpus.
Done: written audit report in `docs/audits/`, all High/Critical closed.

**H-502 — Observability and cost control.** `[core]`
Scope: structured logs, health checks, error tracking (free tier), daily spend report, alert at 80% of cap.
Done: forced budget exhaustion in staging stops moderation and alerts.

**H-503 — Backups and restore drill.** `[process]`
Scope: nightly `pg_dump` off-box, documented restore, timed drill.
Done: restore on a clean host within the target time; runbook in `docs/RUNBOOK.md`.

**H-504 — Deployment.** `[process]` `OD` (hosting + payment channel, D4)
Scope: VPS Docker Compose, Cloudflare setup, secrets handling, deploy and rollback runbook.
Done: deploy from tag; rollback tested.

**H-505 — Closed beta.** `[process]`
Scope: invite-only, caps low, metrics, triage loop.
Done: 2 weeks without a Critical; moderation false-positive/negative review logged.

**H-506 — Public launch gate.** `[process]` `OD`
Checklist: lawyer sign-off (D1), DMCA agent + contact (D6), Audius terms verified (D3), moderation policy approved (D2), payment/hosting stable (D4), backups drilled.
Done: Owner signs the gate in the issue.

---

## W6 — Growth (P2, only after W5)

H-601 Gorse recommendations · H-602 audio embeddings for cold start · H-603 more locales ·
H-604 Capacitor wrapper · H-605 timestamp comments. Each needs a one-line problem statement
and a cost estimate before it becomes a naryad.

---

## Cross-cutting rules

- A wave does not start until the previous gate is signed.
- If a naryad needs a decision not in `OWNER_DECISIONS.md`, the Agent stops and reports (AGENTS §3).
- Audit cadence: every PR (Auditor verdict), plus a scheduled review at each gate.
