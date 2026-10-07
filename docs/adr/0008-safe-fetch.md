# ADR-0008 — Safe outbound fetch (S4): one validated, pinned door for user URLs, one allowlisted door for providers

Status: Accepted

## Context

HUK fetches author-hosted files and provider APIs, but never trusts the URLs
it is given (AGENTS §5 S4). Two failure classes drive the design:

- **SSRF**: a user-supplied URL pointing at loopback, private ranges or the
  cloud metadata service (169.254.169.254), possibly via odd IPv4 spellings
  (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`, short `127.1`),
  IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`), userinfo (`https://u@host/`), or a
  DNS answer that changes between validation and connection (rebinding).
- **Resource abuse**: compression bombs, unbounded bodies, slow-drip servers
  and redirect chains that multiply all of the above.

Constraints: the worker runs on **Bun**, the web container on **Node**; the
`check-no-raw-fetch` CI guard forbids raw HTTP anywhere except
`src/server/net/safe-fetch.ts` and `src/server/net/trusted-fetch.ts`; no new
runtime dependency was acceptable.

## Decision

**Two doors, one transport (H-201):**

- `src/server/net/safe-fetch.ts` — `safeFetch(url, opts)` is the only door for
  user-supplied URLs: GET/HEAD only; https only (http needs the dev/test flag
  `SAFE_FETCH_ALLOW_HTTP`, never set in production); userinfo rejected; port
  allowlist (`SAFE_FETCH_PORTS`, default `443`); the URL is validated per hop
  (the WHATWG parser canonicalises odd IPv4 spellings and IPv6 zones in the
  host position BEFORE any decision, and the classifier also fails closed on
  anything unparseable); DNS is resolved by us (`node:dns`, IPv4 first) and
  **every** resolved address is classified — loopback, private, link-local
  (incl. 169.254.169.254), CGNAT 100.64/10, unspecified, multicast, ULA,
  IPv4-mapped and NAT64-embedded IPv4 are forbidden; the connection is then
  **pinned** to the validated address; redirects (≤3) re-run every check per
  hop with loop detection; no cookies or credentials; connect + total
  timeouts; the body streams and aborts at `maxBytes` counting **decoded**
  bytes (compression bombs die at the cap). Every refusal is a typed
  `SafeFetchError` code (S9).
- `src/server/net/trusted-fetch.ts` — `trustedFetch(url, opts)` is the only
  door to providers: the host must be in `TRUSTED_HOSTS`, configured **in
  code** (api.audius.co, discoveryprovider.audius.co, api.acoustid.org,
  api.audd.io; more arrive with H-205/H-208 naryads), https only, bounded
  retries (≤2, exponential backoff) for idempotent GET on 5xx/429/timeouts,
  and redirects may not leave the trusted host (`HOST_FORBIDDEN`).

**Pinned transport without new dependencies.** The transport is a minimal
HTTP/1.1 client over `node:tls` / `node:net`: it connects to
`pinnedAddress` while keeping `servername` (SNI) and certificate verification
on the hostname — rebinding cannot swap the address after validation, and the
TLS identity is still the hostname. ALPN advertises `http/1.1` only. The
client implements status/head parsing (64 KB head cap), content-length,
chunked and to-EOF framing, and gzip/deflate/brotli decoding through
`node:zlib` with the decoded-byte cap applied per chunk.

**One code path, two runtimes.** Because the transport sits on
`node:tls`/`node:net`/`node:zlib`/`node:dns`, the SAME module serves Node
(vitest) and Bun (the worker). The full case table
(`tests/net/table.ts`, framework-free) runs twice: under vitest
(`tests/net/safe-fetch.test.ts`) and under Bun (`bun run test:bun-net`,
`tests/net/safe-fetch.bun_test.ts`, excluded from vitest by its `*.bun_test.ts`
name). **Result of the dual run (H-201 done criterion): 37/37 cases pass
under both runtimes with no behavioural difference** — including the odd-IPv4
normalisation cases, which prove Node's (V8) and Bun's (JavaScriptCore)
WHATWG URL parsers agree on every hostile spelling in the table. The only
run-time difference observed is performance (Bun finishes the suite ~5×
faster); behaviour, error codes and pinned-connection semantics are
identical.

**Test seams, not production flags.** `safeFetch` accepts injected
`resolver` and `loader` for orchestration tests (rebinding: first answer
public, second private, one resolution, the transport pinned to the first);
the real transport is exercised directly against a local `node:http` server
(`createDefaultLoader` export) — including the proof that it connects to the
pinned address rather than the URL hostname (the URL host `pin-proof.test`
is deliberately unresolvable).

## Consequences

- Every future fetch of a user URL goes through `safeFetch`, every provider
  call through `trustedFetch` (and later through `budget.guard`, S6/H-204);
  `check-no-raw-fetch` keeps the doors closed for everything else.
- The transport speaks HTTP/1.1 only: h2-only servers (rare for file hosts)
  are unreachable; no cookies, no keep-alive pooling (each request opens one
  connection — acceptable at HUK's outbound volume), `deflate` follows the
  RFC (zlib-wrapped) and fails closed on broken raw-deflate servers.
- Trust for the hostname→address mapping rests on our own resolution at
  request time; hosted environments that remap DNS inside the process
  (none today) would need a re-visit.
- IP-literal and DNS failures are fail-closed by construction: unparseable
  addresses are forbidden, not permitted.
