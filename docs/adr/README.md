# ADR index

Numbered sequentially. Check collisions before adding: `ls docs/adr | sed 's/-.*//' | sort | uniq -d` must print nothing.
An ADR is needed for decisions that change direction or are costly to reverse; mechanical choices do not need one.
Status: Proposed → Accepted (owner) → Superseded. Accepted ADRs are not reopened without an owner request.

| # | Title | Status |
|---|---|---|
| 0001 | Rewrite instead of refactor the prototype | Accepted |
| 0002 | Authors keep audio; HUK stores links and hashes | Accepted |
| 0003 | Moderation as a cost-ordered cascade, fail closed | Accepted |
| 0004 | Timeline owned by a single worker; `/now` is a pure read | Accepted |
| 0005 | Postgres-only first; one VPS with Docker Compose | Accepted |
| 0006 | Rankings are deterministic (Wilson + decay); AI audits | Accepted |
