# Known limitations (honest boundaries)

Add an entry in the same PR that knowingly leaves something imperfect. Security-relevant entries carry `release-block`.

| Area | Limitation | Why | Matters when |
|---|---|---|---|
| Fingerprinting | AcoustID's crowd-sourced database covers fewer recordings than commercial ones | free tier chosen for cost | before public launch (re-evaluate AudD) |
| ASR | Singing is transcribed poorly; rare languages weakly | model limits | policy decisions on vocals — low confidence goes to humans |
| Streaming | Author-hosted files may be slow, missing or lack CORS | authors keep files (ADR-0002) | live gaps → skip + availability tracking |
| Anonymity | Operator identity may be required by hosts, payment and legal agents | external requirements | D1, D4, D6 |
| Sync | Browser background audio varies by OS | platform policies | iOS Safari; wrapper in phase 6 |
| Runtime | Node.js only: no middleware/proxy and no `runtime = "edge"` handlers; enforced by `scripts/ci/check-no-edge-runtime.mjs` | S8 boot validation (`src/instrumentation.ts`) covers the Node.js server process only; edge has no equivalent hook here | if edge/middleware is ever needed — revisit the S8 boot-validation design first (H-109) |
| Rate limiting | `CLIENT_IP_HEADER` is trusted as given, so IP limits are only as strong as the origin lock to Cloudflare | traffic that bypasses Cloudflare could spoof the configured header and rotate limiter keys per request | H-504 (origin lock: only Cloudflare can reach the VPS) |
