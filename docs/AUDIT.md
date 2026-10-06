# Audit protocol

The Auditor (Claude, in chat) reviews every naryad PR and each wave gate. The
Agent that wrote the code never signs its own review (not a self-check).

## 1. Per-PR loop

1. Owner (or Agent) gives the Auditor the PR URL (repo is public) or the diff, the naryad issue and the Agent's report.
2. Auditor reads the naryad first: scope, fact base, "done" criteria, owner-decision box.
3. Auditor verifies — it does **not** trust the report:
   - fact base re-checked against the code (file:line exists and says what is claimed);
   - scope respected (files touched ⊆ declared scope; anything else is flagged);
   - contracts: tests exist, fail without the change, pass with it; CI green **on the merge commit**;
   - security invariants S1–S10 (AGENTS §5) against the diff;
   - the three greps (§3) over the naryad's zone;
   - docs updated in the same PR.
4. Verdict: **ACCEPT** · **ACCEPT WITH FOLLOW-UPS** (each follow-up becomes a naryad) · **REWORK** (list of blocking findings) · **ESCALATE** (needs an owner decision).
5. Findings use severities: **Critical** (exploitable now / data loss / legal exposure), **High**, **Medium**, **Low**, **Note**.

## 2. Risk-review checklist (go by risk, not by order)

A PR touching `src/server/guard.ts`, `src/server/net/`, `src/server/moderation/`,
`src/server/budget.ts`, `src/app/api/**`, `prisma/schema.prisma`, `src/worker/**`
or `.github/**` is reviewed against all nine items:

1. **Authorization.** Each new/changed handler: is the guard on the path, with the right role? Default is deny.
2. **Visibility.** Can non-approved, rejected, restricted or unavailable content leak (list endpoints, search, cache keys, error messages, `include` joins)? Are dislikes, IP hashes, transcripts or emails absent from public payloads?
3. **Fail-open defaults.** Every `catch`, `??`, `||`, default arm: does failure grant, approve or skip? (must be closed)
4. **Untrusted input.** Parsed by zod? Size/length bounded? Free of path/URL/command injection? Unicode handled (non-Latin names)?
5. **Outbound calls.** Only through `safe-fetch`; paid calls only through `budget.guard()`; timeouts and retries bounded.
6. **Concurrency and state.** Scheduler single-writer preserved; idempotent jobs; no state advanced inside GET.
7. **Personal data.** New fields are necessary, retention defined, deletable, never logged raw.
8. **Same-effect paths** (§3).
9. **Downgrade ledger.** If a blocking CI check was lowered or an invariant relaxed, the naryad enumerates exactly what it used to catch and shows evidence for each form; a form without evidence stays blocking.

## 3. The three greps (same-effect paths)

Run over the naryad's zone and attach the output to the report:

```bash
# 1. every handler exports a guard call or is allowlisted
node scripts/ci/check-route-auth.mjs
# 2. no raw outbound HTTP outside the safe door
grep -rnE "\b(fetch|axios|got|undici|http\.request|https\.request)\(" src --include=*.ts --include=*.tsx | grep -v "src/server/net/safe-fetch.ts"
# 3. config/env referenced without the project prefix (aliases hide from a prefixed grep)
grep -rn "process\.env" src | grep -v "src/server/env.ts"
```

A fix bound to one call site closes an example, not the class: find every path
reaching the same effect and close it at the common point or list it with a reason.

## 4. Wave gates

Auditor produces `docs/audits/YYYY-MM-DD-<gate>.md` (template §5) and the Owner
signs the gate by merging a PR that adds the report. No next-wave naryad starts earlier.

| Gate | Mandatory checks |
|---|---|
| W1→W2 | authorization matrix complete; rate limits; no raw IP; scheduler single-writer under 2 workers |
| W2→W3 | moderation bypass attempts (params, direct source swap, cached payloads); SSRF suite; prompt-injection corpus; budget exhaustion; takedown latency |
| W5 launch | full security review; privacy review (data inventory vs retention); backup restore; legal checklist; cost dry-run at 3× expected load |

Weekly detective (automated, `merge-ci-audit` in CI): every merge commit on `main`
must have a green required-check set; discrepancies open an issue (report-only).

## 5. Audit report template

```
# Audit <date> — <PR/gate>
Scope reviewed: <commits/files>      Verdict: ACCEPT | FOLLOW-UPS | REWORK | ESCALATE
## Verified facts      (claim → evidence)
## Findings            (severity, file:line, impact, fix, naryad to open)
## Same-effect paths   (greps run, results)
## Residual risk / honest boundaries
## Owner decisions required
```

## 6. Honest-boundary rule

Anything knowingly left imperfect is written down in `docs/LIMITATIONS.md` in the
same PR (what, why, when it matters). A security-relevant limitation also gets
the `release-block` label until the Owner accepts it in writing.
