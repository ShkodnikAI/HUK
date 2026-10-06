# ADR-0003 — Moderation as a cost-ordered cascade, fail closed
Status: Accepted

Decision: stages run cheapest first (declaration → technical → fingerprint → ASR (vocals only) → LLM verdict →
human). Adapters hide providers. Any error, timeout, malformed output or budget stop yields `REVIEW`, never
`APPROVE`. A strong fingerprint match blocks auto-approval. Daily budget caps are enforced by `budget.guard()`.
Policy is a versioned file read at runtime.

Consequences: ~$0.03–0.05 per track; human queue grows when providers fail (visible by design); prompt-injection
resistance depends on delimiting, schema validation and fail-closed defaults (tested with a corpus).
