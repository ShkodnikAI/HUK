# k8s/ — the Kubernetes stack (H-504, Kubernetes edition)

Production manifests for the Rancher-managed single-node cluster. The
orchestration moved here from `deploy/docker-compose.prod.yml` (owner
decision 2026-10-21, ADR-0009); the Docker images are unchanged.

| Path | What it is |
|---|---|
| `base/` | namespace, postgres (StatefulSet + PVC), web/worker (Deployments, Recreate), seed-audio (non-root nginx), nightly backup CronJob, generated ConfigMaps |
| `components/tunnel/` | cloudflared sidecar — outbound-only, no ingress object, no host ports |
| `overlays/prod-no-tunnel/` | production sizes (10 Gi pgdata, 20 Gi backups) + release image tags; the first start applies THIS (RUNBOOK §4) |
| `overlays/prod/` | prod-no-tunnel + tunnel — the full production stack |
| `overlays/ci/` | the CI drill overlay: locally built `ci`-tagged images, no tunnel |
| `jobs/` | explicit one-shot manifests: restore drill, seed copy/export/register — applied by hand, never via an overlay |
| `.env.production.example` | the source of the `huk-env` secret (`kubectl create secret --from-env-file`) |
| `check-env.sh` | pre-flight gate for that env file (run it BEFORE creating the secret) |
| `tests/` | `check-env` test suite + the deliberately broken overlay the CI checker must reject |

Secrets never live in this directory: `.env` is git-ignored, the cluster
secret is created from it at install time (S8). The full operating procedure
— build/import/release, backups, restore drill, kill switch, Rancher
coexistence — is `docs/RUNBOOK.md`.
