# Audit 2026-10-16 — W3 follow-ups, UI series and production stack

Scope reviewed: `main` @ `fc6cb62` — PRs #108 (H-306), #109 (H-307), #110 (H-308), #111 (H-309), #112 (H-120),
#113 (H-121), #114 (H-122), #115 (H-123), #116 (H-504), #117 (H-504 follow-up: URL-safe database password).
Verdict: **ACCEPT WITH FOLLOW-UPS.** No Critical or High finding; nothing needs a revert. The W3 findings H1–H9 are
closed (verified below). Three Medium findings (G1–G3) are scheduled as H-310 and H-311.

## Verified facts (claim → evidence, re-run by the Auditor)

| Claim | Evidence |
|---|---|
| Merge hygiene | `invariants`, `gitleaks`, `lint-typecheck-test-build`, `docker-smoke` green on the merge commits of #108–#115 and #117; `branch-freshness` skipped (non-blocking). The merge commit of #116 (`ddddc1e`) has **no check-runs at all**; the PR head `6dd4351` was fully green, and the next merge `fc6cb62` (#117) is fully green including `deploy-smoke` (finding G4) |
| Guards on current main | `check-route-auth` 42 handlers / 0 violations; `check-no-raw-fetch`, `check-no-process-env`, `check-no-edge-runtime`, `check-provider-guard`, `audio-store`, `check-docs-language`, `check-large-files`: 0 violations |
| Local gates | `eslint .` clean; 324 Prisma-free tests pass (37 files) |
| H-306 (finding H9) | every connection carries `options=-c timezone=UTC` (`src/server/db-url.ts`, applied at `db.ts` and at the scheduler's dedicated client, which also runs `SET TIME ZONE 'UTC'`); web and worker refuse to boot on a non-UTC effective zone (`db-timezone.ts`, `boot.ts`, `worker/index.ts`); raw comparisons against naive columns are pinned (`servableTrack`, `broadcastWindow`, moderation claim, rate-limit bucket, listen-event rollup); the DB suite runs in CI under Europe/Minsk and America/Los_Angeles (`tests/db/run-under-timezone.mjs`); no other connection path exists (`prisma/seed*.ts` use ORM writes only) |
| H-307 (H1, H2, H4, H5, H8) | anonymous listeners contribute no `EARLY_SKIP_PLAYLIST`; signed-in actors at most one per track per UTC day, weighted by reputation; `PLAYLIST_ADD` counted once per owner per track with the owner's reputation; playlist create/add rate-limited (429 + Retry-After); `closeSession` is an atomic conditional update inside a transaction; concurrent open sessions capped at 3; per-actor counters replace the O(n²) scan; `scoreTrack` sums in a canonical order. Matching DB tests exist per rule |
| H-308 (H3) | erasure deletes `ListenEvent`, `ListenSession`, `VoteFlag`, the user's created invites; nulls `Report.reporterId`/`reporterContact` and `ArtistInvite.usedById`; drops `TrackScore` of listened tracks; export covers the same tables; a schema-introspection test fails when a user-keyed column is neither handled nor allowlisted with a reason, and has a failing fixture |
| H-309 (H6, H7, Edge warning) | public like counts exclude flagged voters (one grouped SQL); audio responses are `cache-control: no-store` with ETag and Range intact; Node APIs moved out of `instrumentation.ts` into `boot.ts` behind the `NEXT_RUNTIME` guard |
| UI series (H-120…H-123) | no `dangerouslySetInnerHTML`/`innerHTML` sink in `src/`; lyrics rendered as text (`LyricsText`); `PATCH /api/tracks/[id]/lyrics` guards ARTIST first, owner-scoped lookup returns 404 for foreign ids, rate-limited, audit row stores the length only; authz matrix extended; lyrics validated by one shared pipeline (NFC, control characters rejected, link/address detector mirroring H-303); `GET /api/tracks/mine` returns lyrics only to the owner; EN/RU catalogs have a parity test; Auth.js pages `/signin`, `/check-email`, `/auth-error` resolve the locale in place |
| H-504 stack | one published port, bound to `127.0.0.1`; Postgres, worker and seed server unpublished on a project-local network; every required variable `:?`-required; `check-env.sh` refuses dev defaults, short secrets and non-https origins; `deploy/.env` is git-ignored; resource limits and log rotation set; rollback in `update.sh`; backup verifies the dump with `pg_restore --list`; the CI job `deploy-smoke (prod stack drill)` is green on `fc6cb62` |

### Not verified by the Auditor (sandbox limits)

The Prisma engines cannot be downloaded here: typecheck, build and `tests/db/**` were **not re-run locally**
(accepted on green CI check-runs; logs are not downloadable). The UI was not compared pixel-by-pixel with the design
reference, no real-device playback and no production deploy on the Owner's host were exercised. Findings are from code
reading, not from exploit runs.

## Findings

| # | Sev | Where | Finding | Fix |
|---|---|---|---|---|
| G1 | Medium | `docs/RUNBOOK.md` §2.1 (and the account steps in §2) | The runbook documents a "fallback if Docker Hub is blocked from your host": third-party mirrors and re-publishing the images under another registry. That is a workaround for a provider-side access restriction. The project does not give such instructions: a blocked registry is an Owner decision routed to the legal review (D1), not an operational step. | Replace §2.1 with: if the probe fails, stop, do not work around it, report to the Owner. Keep the facts (what is pulled, from where) |
| G2 | Medium | `src/server/account/service.ts`, `src/server/tracks/takedown.ts:45` | `Track.lyrics` (added by H-123) survives account erasure: own tracks go to `TAKEN_DOWN` but the row keeps the artist's text; the export omits it too. S7 (erasure, export). The PLAN notes "lyrics erasure follows with H-122/H-123"; it was not done. Not public (S2), but retained. | Null `lyrics` on the user's tracks in the erasure transaction; add `lyrics` to the export; extend the erasure and export tests |
| G3 | Medium | `deploy/backup.sh`, `docs/RUNBOOK.md` §9 | Backups (7 daily + 4 weekly) live in a directory on the same host as the database: one disk loss removes both. The runbook states no off-host copy and no note that a restore resurrects erased accounts. | Document an off-host copy step (destination is an Owner choice, no provider assumed) and the post-restore erasure replay requirement |
| G4 | Low | merge `ddddc1e` (#116), `scripts/issue_92_full.txt` | #116 was merged without check-runs on its merge commit (head was green; #117 re-established a green main). An 87-line issue text dump `scripts/issue_92_full.txt` was committed with H-121. | Remove the file; no action for the merge beyond noting it |
| G5 | Info | `deploy/docker-compose.prod.yml` | Worker healthcheck `kill -0 1` proves the process lives, not that the scheduler ticks; `postgres:16` is a floating minor tag. | Optional: heartbeat file check; pin by digest at the next image review |
| G6 | Info | `src/server/tracks/lyrics.ts` | Lyrics edits on an APPROVED track are validated mechanically only (decided in PLAN H-123). H-124 will display lyrics publicly: it must show them only for APPROVED tracks and keep the mechanical-only policy explicit. | Carry into H-124 done criteria |
| G7 | Info | `tests/db/db.test.ts` | A single DB test file of ~6000 lines. | Split by domain when next touched |

## Same-effect paths

G2 is the same class as W3 finding H3 (a new user-keyed datum added after the erasure inventory): the H-308
introspection guard only sees user-keyed columns, not content columns on owned rows. Add a note to the guard's
allowlist reasons and cover `Track.lyrics` explicitly.

## Residual risk

The station has not run on the Owner's host from the production stack; the Docker Hub reachability from that host is
unresolved (Owner / D1). Ranking remains manipulable by a determined actor only through reactions (covered by
anti-fraud) — acceptable for the invited trial.

## Owner decisions required

1. Docker Hub access from the Owner's host: not an engineering task. Options: ask the lawyer (D1) whether and how the
   images may be obtained from that location; or run the production stack on a host in a jurisdiction where the
   registry is served. Blocks the first production deploy (H-504 drill on the real host).
2. Off-host backup destination (G3): Owner choice, possible spend.
