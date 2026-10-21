# HUK RUNBOOK — production on the Owner's Rancher/Kubernetes host

Operating procedure for `https://hukradio.com` on the Owner's single-host
Rancher-managed Kubernetes cluster (ADR-0009). Everything is driven with
`kubectl` from the manifests in `k8s/`; the Docker images are the same
Dockerfile targets as before, built on the host and imported into the
cluster (no registry). Every command is marked:

- `[verified in CI]` — the `deploy-smoke` job replays this exact step on a
  kind cluster on every PR.
- `[not executed here]` — the Agent had no cluster access; the step is
  written out but first runs on the Owner's host.

Isolation in one paragraph (details §12): everything lives in the namespace
`huk`; no Service is published to the host (ClusterIP only); the only door
to the internet is the outbound-only Cloudflare Tunnel. The neighbouring
project and Rancher itself are never touched.

---

## 0. What runs where

| Piece | Manifest | Notes |
|---|---|---|
| `postgres` | `k8s/base/postgres-statefulset.yaml` | StatefulSet + PVC `pgdata` (10 Gi), ClusterIP `huk-postgres:5432`, never published |
| `web` | `k8s/base/web-deployment.yaml` | applies prisma migrations before start; Recreate strategy; probes on `/api/health` |
| `worker` | `k8s/base/worker-deployment.yaml` | never migrates; init container waits for web; Recreate strategy |
| `seed-audio` | `k8s/base/seed-audio-deployment.yaml` | non-root nginx on 8080, PVC `seed-audio`, serves `/seed*` through the tunnel |
| `cloudflared` | `k8s/components/tunnel/` | outbound-only tunnel sidecar, enabled by `overlays/prod` |
| `huk-backup` | `k8s/base/backup-cronjob.yaml` | nightly 04:10 UTC pg_dump → PVC `backup-data`, 7 daily + 4 weekly |
| one-shot jobs | `k8s/jobs/*.yaml` | restore drill, seed copy/export/register — applied by hand, never by an overlay |

The `huk-env` secret (§3) feeds web/worker/postgres/backup via `envFrom`.
Nothing binds to the host; humans reach web with `kubectl port-forward`.

---

## 1. Preflight (once) `[not executed here]`

1. Get a kubeconfig for the cluster: Rancher UI → cluster → **Kubeconfig
   File**, save it and make kubectl use it:
   ```bash
   export KUBECONFIG=~/.kube/huk-rancher.yaml   # or merge into ~/.kube/config
   kubectl cluster-info                          # must answer, no errors
   kubectl get nodes                             # one node, Ready
   kubectl get storageclass                      # note the default (local-path on k3s)
   kubectl get ns huk                            # must NOT exist yet
   ```
2. Docker on the host, and disk headroom: images (~1.5 GB), `pgdata` 10 Gi,
   `backup-data` 20 Gi, seed audio <1 Gi.
3. Check the default StorageClass exists; if the cluster has none, set one:
   `kubectl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'`.

## 2. Docker Hub reachability (probe before the first pull) `[not executed here]`

The cluster pulls four third-party images from Docker Hub on first use:
`postgres:16`, `nginx:1.29-alpine`, `busybox:1.36`,
`cloudflare/cloudflared:2025.9.1` (the build stage also uses `oven/bun:1`
and `oven/bun:1-slim`). From the host:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull"
```

- `200` — the hub is reachable; proceed.
- `000`/timeout — create a free Docker Hub account, generate a **read-only**
  access token, `docker login` on the host (HUK never pushes), and retry. If
  still blocked, the documented fallback (not implemented): a CI task retags
  the five images into ghcr.io and the manifests' `images:` prefixes change
  accordingly — same import workflow afterwards.

## 3. Environment and the `huk-env` secret `[not executed here]`

```bash
cp k8s/.env.production.example k8s/.env    # git-ignored; never commit it
chmod 600 k8s/.env
# fill EVERY value; DATABASE_URL is built from the three POSTGRES_* values:
#   postgresql://<user>:<password>@huk-postgres:5432/<db>
sh k8s/check-env.sh k8s/.env               # refuses dev defaults/placeholders (S8)
kubectl -n huk create secret generic huk-env --from-env-file=k8s/.env
```

Later changes (SMTP credentials, `INITIAL_ADMIN_EMAIL`, tunnel token):

```bash
$EDITOR k8s/.env && sh k8s/check-env.sh k8s/.env
kubectl -n huk create secret generic huk-env --from-env-file=k8s/.env \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n huk rollout restart deployment/huk-web deployment/huk-worker
```

The env gate refuses to let a bad value reach the cluster: empty secrets,
dev defaults (`huk` password, dev salt, mailpit), non-`https://` URLs,
`@example.com` senders, non-URL-safe Postgres passwords (they are embedded
into `DATABASE_URL` — prisma P1013), `DATABASE_URL` pointing anywhere but
the in-cluster `huk-postgres`.

## 4. First start without the tunnel `[not executed here]` (steps marked otherwise are `[verified in CI]`)

1. Build and import the images (§6 step 1–2).
2. Apply the stack **without** the tunnel (the tunnel is added in §5):
   ```bash
   kubectl apply -k k8s/overlays/prod-no-tunnel      # [verified in CI with overlays/ci]
   kubectl -n huk rollout status --timeout=600s statefulset/huk-postgres
   kubectl -n huk rollout status --timeout=600s deployment/huk-web
   kubectl -n huk rollout status --timeout=600s deployment/huk-worker
   kubectl -n huk rollout status --timeout=600s deployment/huk-seed-audio
   ```
   First web boot applies the full migration set — the startupProbe gives it
   up to 5 minutes before health checks kick in.
3. Prove health locally (nothing is published, so use a port-forward):
   ```bash
   kubectl -n huk port-forward svc/huk-web "$HUK_WEB_PORT":3000      # default 3100
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/api/health   # 200
   ```
   `[verified in CI]` — the drill does exactly this through `port-forward`.
4. Sanity: only ClusterIP services exist, migrations ran:
   ```bash
   kubectl -n huk get svc                                            # all ClusterIP
   kubectl -n huk exec statefulset/huk-postgres -- \
     psql -U huk -d huk -At -c 'SELECT count(*) FROM _prisma_migrations'   # >= 1
   ```
   `[verified in CI]`

## 5. The Cloudflare Tunnel and hostnames `[not executed here]`

1. Cloudflare dashboard → Zero Trust → Networks → Tunnels → **Create a
   tunnel** (Cloudflared) → copy the token into `k8s/.env`
   (`CLOUDFLARE_TUNNEL_TOKEN=...`), re-create the secret (§3).
2. Add the sidecar (its only difference from what already runs):
   ```bash
   kubectl apply -k k8s/overlays/prod
   kubectl -n huk rollout status --timeout=600s deployment/huk-cloudflared
   ```
   The pod dials **out** to Cloudflare's edge — the host opens no inbound
   port for HUK.
3. In the tunnel's Public Hostname rules (order matters — the `/seed` rule
   must sit **above** the apex catch-all):
   - `hukradio.com/seed*` → `HTTP` → `huk-seed-audio.huk.svc.cluster.local:80`
   - `hukradio.com/*`     → `HTTP` → `huk-web.huk.svc.cluster.local:3000`
   - a bulk redirect / redirect rule sends `www.hukradio.com` → `https://hukradio.com` (301).
   HSTS at the edge is a later decision (H-501) — leave it off here.
4. Verify from the internet: `curl -sI https://hukradio.com/api/health | head -1` → `200`,
   `curl -s https://hukradio.com/seed/healthz` — no, that path is inside the
   seed server: `curl -sI https://hukradio.com/seed/<file>.mp3 | head -1` after §8.

## 6. Releases: build → import → retag → apply → (if needed) roll back

One release, from the repo checkout on the host:

```bash
git fetch origin main --force && git checkout <tag-or-sha>          # AGENTS §4
TAG="huk-$(date -u +%Y%m%d)-$(git rev-parse --short HEAD)"

docker build --target web    -t "huk/huk-web:$TAG"    .
docker build --target worker -t "huk/huk-worker:$TAG" .

# import into the cluster's container runtime (k3s):
docker save "huk/huk-web:$TAG" "huk/huk-worker:$TAG" | sudo k3s ctr images import -
# (RKE2/Rancher with containerd+nerdctl: build with nerdctl or docker save →
#  `sudo nerdctl -n k8s.io load -i <tar>`; the goal is the same — images
#  visible to the cluster runtime without a registry.)

sed -i "s/newTag: .*/newTag: $TAG/" k8s/overlays/prod-no-tunnel/kustomization.yaml
git add k8s/overlays/prod-no-tunnel/kustomization.yaml && git commit -m "release: $TAG"

kubectl apply -k k8s/overlays/prod            # [verified in CI]
kubectl -n huk rollout status --timeout=600s deployment/huk-web
kubectl -n huk rollout status --timeout=600s deployment/huk-worker
```

Rules:

- **Never ship `:latest`.** With `imagePullPolicy: IfNotPresent` an unpinned
  tag silently keeps the old image after an import. The invariant checker
  rejects `latest` and unpinned tags in CI.
- `web` and `worker` use the **Recreate** strategy: the old pod is stopped
  before the new one starts (single writer, first-boot migrations). Expect a
  short on-air gap of seconds — the timeline self-heals (ARCHITECTURE §5).
- **Rollback**: revert the tag edit (`sed` back to the previous tag) and
  `kubectl apply -k k8s/overlays/prod` again, or
  `kubectl -n huk rollout undo deployment/huk-web` (and `-worker`).
  `[verified in CI]` — the drill applies a deliberately broken image, watches
  the rollout fail, retags back and proves health 200 again.

## 7. First-admin bootstrap `[not executed here]`

Magic links are the only sign-in, so a working `EMAIL_SERVER` is required
first (put the real SMTP credentials in `k8s/.env`, §3). Then:

1. Set `INITIAL_ADMIN_EMAIL` in `k8s/.env` (the first **verified** sign-in
   with that email becomes ADMIN while no ADMIN exists), re-create the
   secret, `rollout restart deployment/huk-web` (§3).
2. Open `https://hukradio.com`, sign in with that email, confirm the
   promotion in the audit log
   (`kubectl -n huk logs deploy/huk-web | grep -i admin`).
3. After promotion, empty `INITIAL_ADMIN_EMAIL` back and re-create the
   secret — the bootstrap is one-shot and must not stay armed.

## 8. Seed audio `[not executed here]`

Generate locally (no audio in git), copy into the PVC, register as SEED
tracks:

```bash
pip install -r scripts/seed-content/requirements.txt
python3 scripts/seed-content/make_seed.py --out public/seed     # deterministic

kubectl delete job huk-seed-copy -n huk --ignore-not-found
kubectl apply -f k8s/jobs/seed-copy.yaml
kubectl -n huk wait --for=condition=ready pod -l job-name=huk-seed-copy --timeout=120s
POD=$(kubectl -n huk get pod -l job-name=huk-seed-copy -o jsonpath='{.items[0].metadata.name}')
kubectl cp public/seed/. huk/"$POD":/var/www/seed
kubectl -n huk delete job huk-seed-copy

# register as tracks (the image tag must match the current release, §6):
sed -i "s|image: huk/huk-worker:.*|image: huk/huk-worker:$TAG|" k8s/jobs/seed-register.yaml
kubectl delete job huk-seed-register -n huk --ignore-not-found
kubectl apply -f k8s/jobs/seed-register.yaml
kubectl -n huk wait --for=condition=complete job/huk-seed-register --timeout=900s
kubectl -n huk logs job/huk-seed-register
kubectl -n huk delete job huk-seed-register
```

`seed-register` is idempotent (upsert by `externalId`), so re-running after
a regeneration is safe. The seed files are served read-only by the
`seed-audio` nginx with a 1-day cache.

## 9. Backups (automatic) and off-box export

The `huk-backup` CronJob runs nightly at 04:10 UTC: `pg_dump -Fc` →
`/backups/daily` (mode 600) on the `backup-data` PVC, verified with
`pg_restore --list`, 7 daily + 4 weekly copies retained. `[verified in CI]`
— the drill triggers the CronJob by hand and completes the round trip in §10.

```bash
kubectl -n huk get cronjob huk-backup
kubectl -n huk get jobs --sort-by=.status.startTime | tail -3
kubectl -n huk logs job/$(kubectl -n huk get jobs -o jsonpath='{.items[0].metadata.name}')
```

A backup that lives on the same node as the database is not a real backup.
Export off-box regularly `[not executed here]`:

```bash
kubectl delete job huk-backup-export -n huk --ignore-not-found
kubectl apply -f k8s/jobs/backup-export.yaml
kubectl -n huk wait --for=condition=ready pod -l job-name=huk-backup-export --timeout=120s
POD=$(kubectl -n huk get pod -l job-name=huk-backup-export -o jsonpath='{.items[0].metadata.name}')
kubectl cp huk/"$POD":/backups/daily ./huk-backups-daily
kubectl -n huk delete job huk-backup-export
# then move ./huk-backups-daily to off-site storage (the drill in §10 is what
# proves the copies are usable).
```

## 10. Restore drill (regular) and the destructive restore

The drill restores the newest dump into a **scratch** database and verifies
a marker row — the live database is never touched. `[verified in CI]`:

```bash
# plant the marker the drill expects (EXPECT_NOTE in the job manifest):
kubectl -n huk exec statefulset/huk-postgres -- \
  psql -U huk -d huk -c "INSERT INTO drill_marker VALUES (42, 'k8s-drill-marker')"

kubectl -n huk create job --from=cronjob/huk-backup drill-backup
kubectl -n huk wait --for=condition=complete job/drill-backup --timeout=300s

kubectl delete job huk-restore-drill -n huk --ignore-not-found
kubectl apply -f k8s/jobs/restore-drill.yaml
kubectl -n huk wait --for=condition=complete job/huk-restore-drill --timeout=600s
kubectl -n huk logs job/huk-restore-drill        # row counts + "drill_marker verified"
kubectl -n huk delete job huk-restore-drill drill-backup
# drop the scratch database when done inspecting (its name is in the log):
kubectl -n huk exec statefulset/huk-postgres -- \
  psql -U huk -d postgres -c 'DROP DATABASE huk_restore_<ts>'
```

**Destructive restore over the live database** — owner-only, irreversible
(AGENTS §3): apply `k8s/jobs/restore-drill.yaml` with
`DUMP_FILE=<exact dump>` and a command override that restores into
`$POSTGRES_DB` with `--clean --if-exists`, after scaling the stack down
(§11) so nothing writes mid-restore. Do it only when the data loss is
already accepted; the scratch drill above is the safe path.

## 11. Kill switch `[verified in CI]`

Take the site offline in one move (listeners get the browser's offline
state; the tunnel stays up but has no backend):

```bash
kubectl -n huk scale deployment/huk-web --replicas=0
# verify offline:
kubectl -n huk port-forward svc/huk-web 3100:3000 &
curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://127.0.0.1:3100/api/health
```

Bring it back:

```bash
kubectl -n huk scale deployment/huk-web --replicas=1
kubectl -n huk rollout status --timeout=600s deployment/huk-web
```

The worker can be frozen the same way (`deployment/huk-worker`) when the
goal is to stop processing rather than stop serving.

## 12. Living next to Rancher (isolation rules)

The host runs another project under Rancher. HUK coexists by staying small,
namespace-scoped and portless:

- Everything HUK owns is in the namespace `huk` — the invariant checker
  fails any manifest rendered outside it.
- No Service of type NodePort/LoadBalancer, no `hostPort`, no
  `hostNetwork/hostPID/hostIPC`, no `hostPath` volumes, no privileged
  containers — all enforced by `scripts/ci/check-k8s-manifests.mjs` in CI.
- PVCs are created through the cluster's default (local-path) provisioner;
  HUK never mounts or writes anywhere else on the host.
- Never touch Rancher's own workloads, its networks/stacks, or the
  neighbouring project's resources. HUK's ingress is the outbound-only
  tunnel — no shared port, no shared network.
- Resource limits bound the stack (~3.9 Gi memory ceiling across all pods;
  ffmpeg/fpcalc passes are the heaviest work, see `worker` limits).
- Both containers run non-root (`bun` uid 1000); postgres runs as uid 999;
  seed-audio nginx as uid 101.

## 13. Open questions (owner)

- Cloudflare free-plan terms for self-hosted audio streaming — verify before
  public launch (does not block beta).
- SMTP provider choice + the SPF/DKIM/DMARC checklist (send a test to
  Gmail/Outlook, require `spf=pass dkim=pass`, then enable real sign-ins).
- D4 (a rented VPS later) reuses these files unchanged: same manifests, same
  build+import workflow, new kubeconfig.
- If the cluster's container runtime is not k3s's containerd, adapt the
  §6 import one-liner (the `docker save → runtime load` pattern stays).
