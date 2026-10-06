# ADR-0005 — Postgres-only first; one VPS with Docker Compose
Status: Accepted

Decision: phase 1 runs `web`, `worker`, `postgres` on one small VPS behind Cloudflare (free). No Redis until
charts/listener counts demand it (M scale). Migrations only (`prisma migrate`); `db push` is forbidden in
scripts. Provider choice and payment channel are owner decision D4.

Consequences: target $12–20/month at start; single point of failure mitigated by nightly off-box backups and a
restore drill; scaling path is vertical first, then split `postgres` and `worker`.
