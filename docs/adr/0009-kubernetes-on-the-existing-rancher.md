# ADR-0009 — Production orchestration on Kubernetes (the existing Rancher cluster)

Status: Accepted (owner decision, chat 2026-10-21)

## Decision

Production orchestration moves from Docker Compose (`deploy/docker-compose.prod.yml`
+ shell ops scripts) to Kubernetes manifests under `k8s/`, deployed with
kustomize into the **Rancher-managed single-node cluster already running on
the Owner's host**. The Docker images do not change: the same Dockerfile
targets (`web`, `worker`) are built and **imported into the cluster's
container runtime** (no registry involved). The dev Compose stack stays for
local development and the `docker-smoke` job; the production Compose stack
and its ops scripts are removed.

The decision was made by the Owner in chat (2026-10-21, translated from the
Russian original): "let us fully rework the project onto the
Docker/Kubernetes stack and carry the changes everywhere they are needed",
with eight sub-decisions:

1. Target: the existing Rancher cluster (no new cluster, no managed K8s).
2. Production Compose is deleted; the dev Compose stack remains.
3. Manifests: kustomize (`k8s/base` + overlays), plain `kubectl apply -k`.
4. PostgreSQL: in-cluster StatefulSet + PVC, nightly pg_dump via a CronJob.
5. Edge: cloudflared as a Deployment — outbound-only, zero inbound ports.
6. Secrets: `kubectl create secret generic huk-env --from-env-file=k8s/.env`
   after the `k8s/check-env.sh` gate — never in git (S8).
7. Ops are kubectl-native: releases by retagging the overlay and applying,
   rollback via `rollout undo`, backups by CronJob, restore drill by a Job,
   kill switch by scaling to zero.
8. Governance: the chat instruction is the owner decision (recorded here);
   the Auditor formalizes the naryad post factum.

## Consequences

- `web`, `worker`, `seed-audio`, `cloudflared` use the **Recreate** strategy:
  a release briefly gaps the radio instead of running two writers (single
  writer, ADR-0004; first-boot migrations; cheap by default). HA is a later
  decision.
- Image releases are pinned tags, never `latest` (`imagePullPolicy:
  IfNotPresent` + import-based releases would silently run a stale image);
  the invariant checker (`scripts/ci/check-k8s-manifests.mjs`) rejects
  unpinned tags, privileged containers, host namespaces/path, published
  (non-ClusterIP) Services, missing probes/limits, and any Secret rendered
  from git.
- PVCs assume the single node's local-path provisioner; web and worker share
  the broadcast-cache PVC on the same node (RWO is node-scoped).
- The Kubernetes drill runs in CI on a kind cluster (`deploy-smoke`, not a
  required check): boot, migrations, ClusterIP-only, port-forward health,
  backup → restore round trip, kill switch, broken-image rollback.
- What ADR-0005 decided and still holds: Postgres-only (no Redis), migrations
  only (`prisma migrate`), $12–20/month cost target, vertical scaling first.
  Only its orchestration clause (Compose on one VPS) is superseded.
