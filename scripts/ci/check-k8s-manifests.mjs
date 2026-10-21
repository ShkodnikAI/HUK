#!/usr/bin/env node
// scripts/ci/check-k8s-manifests.mjs (H-504, Kubernetes edition)
//
// Reads the RENDERED manifest list — the JSON array produced by
//   kubectl kustomize -o json k8s/overlays/<name>
// — and enforces the production invariants that check-prod-compose.mjs used
// to enforce for the compose stack. A checker that cannot fail is not a
// check: CI also renders k8s/tests/bad and REQUIRES this script to exit 1
// on it.
//
// Invariants:
//   - everything lives in the namespace "huk" (Rancher coexistence, RUNBOOK §12)
//   - Services are ClusterIP only — nothing is published to the host
//   - no privileged containers, no hostNetwork/hostPID/hostIPC, no hostPath
//     volumes, no hostPort (same hardening set the compose checker had)
//   - allowPrivilegeEscalation: false everywhere
//   - runAsNonRoot everywhere except the cloudflared image (runs with its
//     default user; the compose stack ran it the same way)
//   - every container (init included) has cpu+memory limits
//   - every long-running container has at least one probe (CronJobs and the
//     cloudflared sidecar excepted, as in the compose stack)
//   - image tags are pinned and never "latest" (IfNotPresent + import-based
//     releases would silently run a stale image)
//   - web/worker/seed-audio/cloudflared use the Recreate strategy (single
//     writer, first-boot migrations — no rolling overlap)
//   - the backup CronJob is Forbid-concurrent and scheduled
//   - web/worker/postgres/backup consume the huk-env secret
//   - no Secret object is ever rendered from git (secrets come from
//     `kubectl create secret`, S8)
//
// Usage: node scripts/ci/check-k8s-manifests.mjs <rendered.json>
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: check-k8s-manifests.mjs <rendered.json>');
  process.exit(2);
}

let docs;
try {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  docs = Array.isArray(parsed) ? parsed : [parsed];
} catch (e) {
  console.error(`cannot parse rendered manifests: ${e.message}`);
  process.exit(1);
}
if (!docs.length) {
  console.error('rendered manifest list is empty');
  process.exit(1);
}

const errors = [];
const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'CronJob']);
const workloads = docs.filter((d) => WORKLOAD_KINDS.has(d.kind));
const services = docs.filter((d) => d.kind === 'Service');

// --- 1. namespace "huk" everywhere ---
for (const d of docs) {
  if (d.kind === 'Namespace') {
    if (d.metadata?.name !== 'huk') {
      errors.push(`Namespace must be "huk", got "${d.metadata?.name ?? '?'}"`);
    }
    continue;
  }
  const ns = d.metadata?.namespace;
  if (ns !== 'huk') {
    errors.push(`${d.kind}/${d.metadata?.name ?? '?'}: namespace must be "huk", got "${ns}"`);
  }
}

// --- 2. required workloads ---
const workloadNames = new Set(workloads.map((d) => d.metadata?.name));
for (const w of ['huk-postgres', 'huk-web', 'huk-worker', 'huk-seed-audio', 'huk-backup']) {
  if (!workloadNames.has(w)) errors.push(`missing required workload "${w}"`);
}

// --- 3. Services are ClusterIP only (nothing published to the host) ---
for (const s of services) {
  const t = s.spec?.type ?? 'ClusterIP';
  if (t !== 'ClusterIP') {
    errors.push(`Service/${s.metadata?.name}: type must be ClusterIP, got "${t}"`);
  }
}

function podTemplate(d) {
  return d.kind === 'CronJob' ? d.spec?.jobTemplate?.spec?.template : d.spec?.template;
}

function allContainers(tpl) {
  return [
    ...(tpl?.spec?.containers ?? []),
    ...(tpl?.spec?.initContainers ?? []),
  ];
}

function mainContainers(tpl) {
  return tpl?.spec?.containers ?? [];
}

function imageTag(img) {
  const last = String(img).split('/').pop();
  const i = last.lastIndexOf(':');
  return i === -1 ? null : last.slice(i + 1);
}

const NONROOT_ALLOW = new Set(['cloudflared']);
const PROBE_ALLOW = new Set(['cloudflared']);
const RECREATE_FOR = new Set(['huk-web', 'huk-worker', 'huk-seed-audio', 'huk-cloudflared']);
const NEEDS_SECRET = new Set(['huk-web', 'huk-worker', 'huk-postgres', 'huk-backup']);

for (const d of workloads) {
  const wname = d.metadata?.name ?? '?';
  const tpl = podTemplate(d);
  if (!tpl?.spec) {
    errors.push(`${d.kind}/${wname}: no pod template`);
    continue;
  }

  // --- pod-level isolation ---
  const pspec = tpl.spec;
  if (pspec.hostNetwork) errors.push(`${d.kind}/${wname}: hostNetwork is forbidden`);
  if (pspec.hostPID) errors.push(`${d.kind}/${wname}: hostPID is forbidden`);
  if (pspec.hostIPC) errors.push(`${d.kind}/${wname}: hostIPC is forbidden`);
  for (const v of pspec.volumes ?? []) {
    if (v.hostPath) {
      errors.push(`${d.kind}/${wname}: hostPath volume "${v.name}" is forbidden`);
    }
  }

  // --- per-container hardening ---
  for (const c of allContainers(tpl)) {
    const cname = c.name ?? '?';

    const tag = imageTag(c.image ?? '');
    if (!tag) errors.push(`${d.kind}/${wname}/${cname}: image "${c.image}" has no explicit tag`);
    else if (tag === 'latest') {
      errors.push(`${d.kind}/${wname}/${cname}: image tag "latest" is forbidden (pin the release tag)`);
    }

    const limits = c.resources?.limits ?? {};
    if (!limits.memory) errors.push(`${d.kind}/${wname}/${cname}: no memory limit`);
    if (!limits.cpu) errors.push(`${d.kind}/${wname}/${cname}: no cpu limit`);

    const sc = c.securityContext ?? {};
    if (sc.privileged) errors.push(`${d.kind}/${wname}/${cname}: privileged is forbidden`);
    if (sc.allowPrivilegeEscalation !== false) {
      errors.push(`${d.kind}/${wname}/${cname}: allowPrivilegeEscalation must be false`);
    }
    const nonRoot = sc.runAsNonRoot === true || pspec.securityContext?.runAsNonRoot === true;
    if (!nonRoot && !NONROOT_ALLOW.has(cname)) {
      errors.push(`${d.kind}/${wname}/${cname}: runAsNonRoot is required (pod or container level)`);
    }

    for (const p of c.ports ?? []) {
      if (p.hostPort !== undefined) {
        errors.push(`${d.kind}/${wname}/${cname}: hostPort is forbidden (port ${p.containerPort})`);
      }
    }
  }

  // --- probes on the long-running containers ---
  if (d.kind !== 'CronJob') {
    for (const c of mainContainers(tpl)) {
      if (PROBE_ALLOW.has(c.name)) continue;
      const hasProbe =
        c.readinessProbe !== undefined ||
        c.livenessProbe !== undefined ||
        c.startupProbe !== undefined;
      if (!hasProbe) {
        errors.push(`${d.kind}/${wname}/${c.name}: no readiness/liveness/startup probe`);
      }
    }
  }

  // --- Recreate strategy for the stateful single-replica deployments ---
  if (d.kind === 'Deployment' && RECREATE_FOR.has(wname)) {
    if (d.spec?.strategy?.type !== 'Recreate') {
      errors.push(`Deployment/${wname}: strategy must be Recreate (single writer / first-boot migrations)`);
    }
  }

  // --- CronJob discipline ---
  if (d.kind === 'CronJob') {
    if (d.spec?.concurrencyPolicy !== 'Forbid') {
      errors.push(`CronJob/${wname}: concurrencyPolicy must be Forbid`);
    }
    if (!d.spec?.schedule) errors.push(`CronJob/${wname}: schedule is empty`);
  }

  // --- the huk-env secret feeds the app workloads ---
  if (NEEDS_SECRET.has(wname)) {
    const usesSecret = allContainers(tpl).some(
      (c) =>
        (c.envFrom ?? []).some((e) => e.secretRef?.name === 'huk-env') ||
        (c.env ?? []).some((e) => e.valueFrom?.secretKeyRef?.name === 'huk-env'),
    );
    if (!usesSecret) errors.push(`${d.kind}/${wname}: does not consume the huk-env secret`);
  }
}

// --- 4. no Secret object ever rendered from git (S8) ---
for (const d of docs) {
  if (d.kind === 'Secret') {
    errors.push(`${d.metadata?.name ?? '?'}: a Secret must never be rendered from the repo (kubectl create secret, S8)`);
  }
}

if (errors.length) {
  console.error(`k8s manifest invariants: FAILED (${errors.length} violation(s))`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `k8s manifest invariants: OK (${workloads.length} workloads, ${services.length} services)`,
);
