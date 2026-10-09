# AGENTS.md — HUK for the AI coder agent

> Entry point to the working method. Read it before any task. It does not
> replace `docs/ARCHITECTURE.md` or the ADRs; it says where the truth lives,
> what you may decide alone, and what "done" means.

## 0. Roles

| Role | Who | Does | Never does |
|---|---|---|---|
| **Owner** | ShkodnikAI | Sets direction; decides irreversible, identity and legal matters (naryads with the owner-decision box, §3). Merge authority is delegated to the Agent (D11) | — |
| **Agent** | the coding agent | Executes published naryads: one branch and one PR each; merges its own PR once every required check is green on the merge commit; reports per §10 with every task listed; supplies evidence for audits | Creates or edits naryads, writes audit records or verdicts, starts unpublished work, edits `.github/` or `scripts/ci/` outside a naryad that says so, merges with a red/missing/skipped required check, self-certifies |
| **Auditor** | Claude (in chat) | Verifies merged work after the fact (per PR when the Owner passes it on, and at every wave gate); writes the audit records; **writes naryads from `docs/PLAN.md` and from findings and publishes them as issues** | Writes feature code, merges feature PRs |

A naryad (work order) is a GitHub issue in the form of `.github/ISSUE_TEMPLATE/naryad.yml`, **written and published by the Auditor**. Scope and acceptance criteria live in that issue (it wins over the card in `docs/PLAN.md` where they differ). The Agent never creates or edits naryads; follow-ups it finds go into the report under `Unresolved` and the Auditor turns them into naryads.

**Delivered is not accepted.** Merged on green CI = *delivered*. *Accepted* is the Auditor's post-merge verdict (`docs/AUDIT.md`). Because the Agent merges without a prior review, naryads carry testable done criteria and later waves wait for the gate record (§6.9).

## 1. Code is the source of truth, not prose

READMEs, ADRs and comments can lag behind the code. Before acting on any
description, verify it with a fact: `grep` the code, run it, read CI.
"The doc says X" is not a fact; "grep confirms X" is.

## 2. Identity (do not drift)

HUK is a **free, non-commercial, international 24/7 radio** for music that
authors publish themselves, with AI-assisted moderation and rankings.

- Authors keep their files. HUK stores **no user audio** (only metadata,
  hashes and links). Seed content is the only audio we host.
- No ads, no paid placement, no payouts to authors. Donations go to the
  developer for the software, never tied to tracks or the station.
- Moderation policy is narrow: blatant crime and nastiness (`policy/moderation-policy.md`).
- Every ranking is a deterministic, explainable algorithm. AI audits and
  detects abuse; AI does not decide chart positions.

Non-goals: hosting audio, ad products, voice/DJ features, user-to-user DMs.

## 3. Decision boundary

**Decide alone:** file/module layout, naming, library choice inside an accepted
ADR, test design, wording of docs.

**Stop and ask the owner (put it in the report, do not assume):**
- rewriting git history, deleting data, anything irreversible;
- changing an accepted ADR or `AGENTS.md` §2/§5;
- anything that changes what content is allowed, who can see what, or what we
  collect about people;
- adding a paid third-party service or raising a spend cap;
- a new user-facing legal text.

A naryad with the "owner decision" box ticked must not start before the
decision is written in the issue.

## 4. Synchronization (stale checkouts are the #1 own mistake)

```bash
git fetch origin main --force
git log origin/main -1 --format='%H %ci %s'
git reset --hard origin/main      # only on a clean working tree
git log -1 --format='%h %s'       # must match the line above
```
Compare with `main` again before opening the PR, not only before starting.

## 5. Security invariants (non-negotiable; CI enforces what it can)

- **S1 — Authorization.** Every mutating route (POST/PUT/PATCH/DELETE) and every
  moderation/admin route calls the central guard (`requireUser` / `requireRole`
  from `src/server/guard.ts`). Public mutations are listed, with a reason, in
  `scripts/ci/public-routes.txt`. *(CI: `route-auth-guard`.)*
- **S2 — No moderation bypass.** Content that is not `APPROVED` is never served
  to the public by any parameter, header or route. Moderators see it only
  through role-checked endpoints.
- **S3 — No stored user audio, except the broadcast window.** No code path
  persists user-supplied audio, with two exceptions. (a) A moderation fetch is
  transient (temp file, deleted in `finally`). (b) The **broadcast cache**
  (Owner decision D14, `src/server/broadcast/audio-cache.ts` only): a copy of
  the audio for the slot on air and the next five slots, written only for an
  `APPROVED`, available `DIRECT_URL` track whose bytes match the moderated
  `contentHash`, kept in a private directory outside every public path, deleted
  when the slot has ended, the track leaves the window, becomes unavailable,
  is taken down or is retired, and swept when the worker starts. No route
  serves a cached file that is not in the window. Anything else that writes
  user audio to disk is a Critical defect. *(CI: `audio-store`.)*
- **S4 — Two doors for outbound HTTP.** User-supplied URLs go
  only through `src/server/net/safe-fetch.ts` (blocks private/loopback/link-local
  ranges after DNS resolution, size and time caps, redirect re-validation); fixed provider hosts (Audius, ASR, LLM) go through `src/server/net/trusted-fetch.ts` (host allowlist, timeouts).
  *(CI: `no-raw-fetch`.)*
- **S5 — Untrusted text is data.** Titles, transcripts, comments and links are
  delimited, never concatenated into instructions; LLM output is schema-validated
  and the default on any doubt or failure is human review (fail closed).
- **S6 — Cost fuse.** Every paid API call goes through `budget.guard()`; daily
  caps come from env; exceeding a cap stops the stage and queues work, it never
  silently continues.
- **S7 — Minimal personal data.** IPs only as salted hashes with rotating salt;
  retention jobs exist for listen events and transcripts; no third-party
  trackers; exports and account deletion work.
- **S8 — Secrets.** None in the repo; env is validated at boot (`src/server/env.ts`).
- **S9 — Fail closed, fail loud.** A default arm that grants access, approves a
  track or skips a check is a defect. Refusals produce a typed error and an
  audit record, not a silent empty success.
- **S10 — Same-effect paths.** A fix is not done until every path reaching the
  same effect is closed at a common point or listed in the report with a reason
  (see the three greps in `docs/AUDIT.md`).

## 6. The naryad contract — what "done" means

1. **Start only from a published naryad:** an open issue labelled `naryad` whose *Step 0* conditions hold (dependencies
   merged on `main`, wave gate recorded). The issue text is the whole specification. Attachments and chat messages do not
   survive between sessions: if something you need is missing, stop and report `blocked`; never reconstruct a missing
   document from memory.
2. Branch → push → **PR open** (`Closes #N`). A local-only branch is not delivered.
3. **Merge it yourself** (merge commit, so one commit per logical step stays visible) only when **every required check is
   green on the merge commit**. Never bypass; never merge on a red, missing or unexpectedly skipped required check: stop and
   report. Auditor-authored PRs (audit records, policy and plan updates) are merged by you under the same rule.
4. One commit per logical step.
5. The PR body follows `.github/pull_request_template.md`: what was done, the fact base (file:line), the contracts (tests)
   proving it, explicit assumptions, what is unresolved. A partial result is never presented as complete, and the report
   lists **every task** of the naryad with its own status.
6. Docs touched by the change are updated in the same PR.
7. You never mark your own work accepted and never write audit records or verdicts; findings arrive as new naryads.
8. **Revert first for Critical.** For a Critical finding (exploitable now, data loss, legal exposure) the Auditor publishes a
   `[bugfix]` naryad labelled `release-block` whose first task is to revert the offending merge through a PR; the fix follows.
9. **Waves.** Naryads of the next wave are published only after the gate record of the previous wave is on `main`.
   Do not start work that is not published.

## 7. Where the truth lives

| Question | Not here (may be stale) | Here |
|---|---|---|
| What does the system do? | README | `docs/ARCHITECTURE.md`, then the code |
| Why was it decided? | memory, chat | `docs/adr/` |
| What is the data model? | prose | `prisma/schema.prisma` |
| Is a route protected? | a comment | the handler + `scripts/ci/public-routes.txt` |
| What does CI really check? | job names | `.github/workflows/ci.yml` |
| What is moderated and how? | prompt text in chat | `policy/moderation-policy.md` + `src/server/moderation/` |
| What is the plan? | issue titles | `docs/PLAN.md` |

## 8. Typical mistakes seen in this codebase (prototype v0.2.1)

- Admin/moderation endpoints with no authentication; a `?mod=1` query that
  bypassed moderation (S1, S2).
- Engine state advanced inside GET requests under an in-process mutex (use the
  worker, S-ARCH in ADR-0004).
- `db push --accept-data-loss` in scripts (never in prod; migrations only).
- Client-supplied `uploaderId` trusted as identity.
- Binary assets and a SQLite file committed to git.
- Title validation that rejected non-Latin/Cyrillic letters (breaks i18n).
- Untrusted transcript concatenated into the LLM prompt (S5).

## 9. Language

Documentation, ADRs, commit messages, code identifiers and comments: **English**.
User-facing strings live in message catalogs (`messages/en.json` is the source,
others are translations). Cyrillic in fixtures/message catalogs is content, not docs.

## 10. Reporting format (end of every naryad)

```
Result:        done | partial | blocked
Tasks:         one line per task of the naryad: done | partial | not done (+ why)
Fact base:     file:line, commands run, output
Contracts:     tests added/changed, CI links (merge commit)
Merge:         merge commit SHA and the green required checks on it
Same-effect:   other paths checked (grep output) or "none found"
Assumptions:   ...
Unresolved:    ... (proposed follow-ups for the Auditor)
Owner decisions needed: ...
```
