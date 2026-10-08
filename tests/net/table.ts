// H-201 (S4) — the shared case table for safe-fetch/trusted-fetch.
// Framework-free ON PURPOSE: the same cases run under Node (vitest) and
// under the Bun runtime used by the worker (`bun run test:bun-net`).
// Cases use two seams:
//   - `resolver` injection for everything DNS-related (classification,
//     rebinding), and
//   - the REAL pinned transport driven directly against a local node:http
//     server for streaming/cap/timeout behaviour on real sockets.
// No case opens a real outbound connection.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { safeFetch, createDefaultLoader, SafeFetchError, isForbiddenAddress } from "../../src/server/net/safe-fetch";
import { trustedFetch, TRUSTED_HOSTS } from "../../src/server/net/trusted-fetch";

process.env.DATABASE_URL ??= "postgresql://huk:huk@localhost:5432/huk";
process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";

export function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

export async function errorCodeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof SafeFetchError)) {
      throw new Error(`expected SafeFetchError, got ${String(e)}`);
    }
    return e.code;
  }
  throw new Error("expected the promise to reject");
}

/** A resolver that maps the hostname to itself (identity). */
const identityResolver = async (hostname: string) => [hostname];

/** A loader that must never be reached; fails the case if it is. */
const neverLoader = () => {
  throw new Error("the transport must not be reached for this case");
  return Promise.resolve({} as never);
};

type ServerHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function withServer(handler: ServerHandler, fn: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const realLoader = createDefaultLoader();

function driveRealLoader(port: number, opts: {
  path: string;
  method?: "GET" | "HEAD";
  maxBytes: number;
  totalTimeoutMs: number;
  host?: string;
}) {
  const host = opts.host ?? "127.0.0.1";
  return realLoader({
    url: new URL(`http://${host}:${port}${opts.path}`),
    pinnedAddress: "127.0.0.1", // the pin: connect here…
    hostname: host, // …while Host/SNI keep this
    method: opts.method ?? "GET",
    headers: { host: `${host}:${port}`, accept: "*/*", "user-agent": "HUK-safe-fetch/1" },
    maxBytes: opts.maxBytes,
    connectTimeoutMs: 2_000,
    totalTimeoutMs: opts.totalTimeoutMs,
  });
}

// ───────────────── the table ─────────────────

export const cases: Array<{ name: string; run: () => Promise<void> }> = [];
const case_ = (name: string, run: () => Promise<void>): void => {
  cases.push({ name, run });
};

// Group A — classification of literal and DNS-resolved addresses (S4).

for (const [name, url] of [
  ["loopback 127.0.0.1", "http://127.0.0.1/x"],
  ["decimal IPv4 2130706433", "http://2130706433/x"],
  ["hex IPv4 0x7f000001", "http://0x7f000001/x"],
  ["octal IPv4 0177.0.0.1", "http://0177.0.0.1/x"],
  ["short IPv4 127.1", "http://127.1/x"],
  ["IPv6 loopback [::1]", "http://[::1]/x"],
  ["IPv4-mapped [::ffff:127.0.0.1]", "http://[::ffff:127.0.0.1]/x"],
  ["ULA [fd00::1]", "http://[fd00::1]/x"],
  ["link-local [fe80::1]", "http://[fe80::1]/x"],
  ["cloud metadata 169.254.169.254", "http://169.254.169.254/latest"],
  ["unspecified 0.0.0.0", "http://0.0.0.0/x"],
  ["CGNAT 100.64.0.1", "http://100.64.0.1/x"],
] as const) {
  case_(`rejects ${name} with PRIVATE_ADDRESS`, async () => {
    const seen: string[] = [];
    const code = await errorCodeOf(
      safeFetch(url, {
        allowHttp: true,
        resolver: async (h) => {
          seen.push(h);
          return [h];
        },
        loader: neverLoader,
      }),
    );
    assert(code === "PRIVATE_ADDRESS", `expected PRIVATE_ADDRESS, got ${code}`);
  });
}

case_("URL parser normalises odd IPv4 forms before any decision", async () => {
  const seen: string[] = [];
  await errorCodeOf(
    safeFetch("http://2130706433/x", {
      allowHttp: true,
      resolver: async (h) => {
        seen.push(h);
        return [h];
      },
      loader: neverLoader,
    }),
  ).then((code) => assert(code === "PRIVATE_ADDRESS", `got ${code}`));
  assert(seen.length === 1 && seen[0] === "127.0.0.1", `resolver must see the canonical address, saw ${seen.join(",")}`);
});

case_("rejects a hostname that resolves to a private address (injected resolver)", async () => {
  const code = await errorCodeOf(
    safeFetch("https://internal.example/x", {
      resolver: async () => ["192.168.0.20"],
      loader: neverLoader,
    }),
  );
  assert(code === "PRIVATE_ADDRESS", `got ${code}`);
});

case_("rejects userinfo (https://good@evil.example) before DNS", async () => {
  const code = await errorCodeOf(
    safeFetch("https://good@evil.example/x", { resolver: identityResolver, loader: neverLoader }),
  );
  assert(code === "USERINFO_FORBIDDEN", `got ${code}`);
});

for (const port of [22, 6379, 5432]) {
  case_(`rejects port ${port} with PORT_FORBIDDEN`, async () => {
    const code = await errorCodeOf(
      safeFetch(`https://provider.example:${port}/x`, { resolver: identityResolver, loader: neverLoader }),
    );
    assert(code === "PORT_FORBIDDEN", `got ${code}`);
  });
}

case_("rejects plain http without the dev/test flag (S4)", async () => {
  const code = await errorCodeOf(
    safeFetch("http://provider.example/x", { resolver: identityResolver, loader: neverLoader }),
  );
  assert(code === "INSECURE_TRANSPORT", `got ${code}`);
});

case_("rejects DNS failure (injected resolver throws)", async () => {
  const code = await errorCodeOf(
    safeFetch("https://nope.example/x", {
      resolver: async () => {
        throw new Error("NXDOMAIN");
      },
      loader: neverLoader,
    }),
  );
  assert(code === "DNS_FAILED", `got ${code}`);
});

case_("rejects an empty resolver answer", async () => {
  const code = await errorCodeOf(
    safeFetch("https://empty.example/x", { resolver: async () => [], loader: neverLoader }),
  );
  assert(code === "DNS_FAILED", `got ${code}`);
});

case_("isForbiddenAddress agrees with the table on every address", () => {
  const forbidden = [
    "127.0.0.1", "127.7.7.7", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255", "240.0.0.1",
    "::", "::1", "::ffff:10.0.0.1", "fd00::1", "fe80::1", "ff02::1", "::ffff:169.254.169.254",
    // H-213 (G4): IANA special-purpose v4 ranges + the auditor's probe table.
    "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.10",
    // IPv6 forms that embed (or could hide) an IPv4, and other non-global.
    "::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b:1::7f00:1",
    "::ffff:0:7f00:1", "2001:db8::1", "64:ff9b::7f00:1",
  ];
  for (const a of forbidden) assert(isForbiddenAddress(a), `${a} must be forbidden`);
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111", "64:ff9b::808:808"];
  for (const a of allowed) assert(!isForbiddenAddress(a), `${a} must be allowed`);
  return Promise.resolve();
});

// Group B — orchestration over the seams (rebinding, redirects).

case_("rebinding: the connection is pinned to the FIRST validated answer", async () => {
  const calls: string[] = [];
  const pinnedSeen: string[] = [];
  const resolver = async (): Promise<string[]> => {
    calls.push("resolve");
    return calls.length === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
  };
  const res = await safeFetch("https://rebinding.example/file", {
    resolver,
    loader: async (req) => {
      pinnedSeen.push(req.pinnedAddress);
      return { status: 200, headers: {}, body: new TextEncoder().encode("ok"), bytes: 2, url: req.url.href };
    },
  });
  assert(res.status === 200, "expected the loader answer to pass through");
  assert(calls.length === 1, `resolver must be called exactly once, was ${calls.length}`);
  assert(pinnedSeen.length === 1 && pinnedSeen[0] === "93.184.216.34", `the transport must be pinned to the first answer, saw ${pinnedSeen.join(",")}`);
});

case_("redirect to an internal address is re-validated and rejected", async () => {
  const code = await errorCodeOf(
    safeFetch("https://outer.example/redir", {
      allowHttp: true,
      resolver: async (h) => (h === "outer.example" ? ["93.184.216.34"] : ["127.0.0.1"]),
      loader: async () => ({
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
        body: null,
        bytes: 0,
        url: "https://outer.example/redir",
      }),
    }),
  );
  assert(code === "PRIVATE_ADDRESS", `got ${code}`);
});

case_("redirect loop is detected", async () => {
  let n = 0;
  const code = await errorCodeOf(
    safeFetch("https://loop.example/a", {
      resolver: async () => ["93.184.216.34"],
      loader: async (req) => {
        n++;
        const next = req.url.pathname === "/a" ? "/b" : "/a";
        return {
          status: 302,
          headers: { location: next },
          body: null,
          bytes: 0,
          url: req.url.href,
        };
      },
    }),
  );
  assert(code === "REDIRECT_LOOP", `got ${code}`);
  assert(n <= 3, `loop must be caught quickly, took ${n} hops`);
});

case_("more than 3 redirects is TOO_MANY_REDIRECTS", async () => {
  let n = 0;
  const code = await errorCodeOf(
    safeFetch("https://chain.example/start", {
      resolver: async () => ["93.184.216.34"],
      loader: async (req) => {
        n++;
        return {
          status: 302,
          headers: { location: `/hop-${n}` },
          body: null,
          bytes: 0,
          url: req.url.href,
        };
      },
    }),
  );
  assert(code === "TOO_MANY_REDIRECTS", `got ${code}`);
});

case_("sameHostOnly: a redirect leaving the trusted host is HOST_FORBIDDEN", async () => {
  const code = await errorCodeOf(
    safeFetch("https://trusted.example/redir", {
      resolver: async () => ["93.184.216.34"],
      loader: async () => ({
        status: 302,
        headers: { location: "https://untrusted.example/x" },
        body: null,
        bytes: 0,
        url: "https://trusted.example/redir",
      }),
      sameHostOnly: true,
    }),
  );
  assert(code === "HOST_FORBIDDEN", `got ${code}`);
});

case_("GET success passes status/headers/body through", async () => {
  const res = await safeFetch("https://ok.example/file", {
    resolver: async () => ["93.184.216.34"],
    loader: async () => ({
      status: 200,
      headers: { "content-type": "audio/mpeg", etag: '"v1"' },
      body: new TextEncoder().encode("AUDIO"),
      bytes: 5,
      url: "https://ok.example/file",
    }),
  });
  assert(res.status === 200 && res.headers.etag === '"v1"', "headers must pass through");
  assert(new TextDecoder().decode(res.body!) === "AUDIO", "body must pass through");
});

// Group C — the REAL pinned transport against a local server (real sockets).

case_("the pinned transport connects to the pinned address, not the URL hostname", async () => {
  await withServer(
    (req, res) => {
      assert(req.headers.host === "pin-proof.test:0" || (req.headers.host ?? "").startsWith("pin-proof.test"), `server must see the hostname Host header, saw ${req.headers.host}`);
      res.end("pinned-ok");
    },
    async (port) => {
      // "pin-proof.test" is unresolvable on purpose: if the transport
      // resolved the hostname instead of using the pinned address, the
      // connect would fail.
      const res = await driveRealLoader(port, {
        path: "/",
        maxBytes: 64 * 1024,
        totalTimeoutMs: 5_000,
        host: "pin-proof.test",
      });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(new TextDecoder().decode(res.body!) === "pinned-ok", "unexpected body");
    },
  );
});

case_("no cookies or credentials are ever sent", async () => {
  await withServer(
    (req, res) => {
      assert(!req.headers.cookie, "no cookie header may be sent");
      assert(!req.headers.authorization, "no authorization header may be sent");
      res.end("clean");
    },
    async (port) => {
      const res = await driveRealLoader(port, { path: "/", maxBytes: 64 * 1024, totalTimeoutMs: 5_000 });
      assert(res.status === 200, `expected 200, got ${res.status}`);
    },
  );
});

case_("body larger than maxBytes is aborted mid-stream", async () => {
  const TOTAL = 4 * 1024 * 1024;
  let attempted = 0;
  await withServer(
    (_req, res) => {
      res.setHeader("content-length", String(TOTAL));
      res.on("error", () => {}); // the client will destroy the socket mid-body
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) return;
        res.write(chunk);
        attempted += chunk.byteLength;
      }, 5);
      res.on("close", () => {
        clearInterval(timer);
      });
    },
    async (port) => {
      const code = await errorCodeOf(
        driveRealLoader(port, { path: "/big", maxBytes: 64 * 1024, totalTimeoutMs: 10_000 }),
      );
      assert(code === "BODY_TOO_LARGE", `got ${code}`);
      assert(attempted > 0 && attempted < TOTAL, `client must abort mid-stream (server attempted ${attempted} of ${TOTAL})`);
    },
  );
});

case_("a slow-drip response hits the total timeout", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("content-length", "1000000");
      res.write("x");
      const timer = setInterval(() => res.write("x"), 120);
      res.on("close", () => clearInterval(timer));
    },
    async (port) => {
      const code = await errorCodeOf(
        driveRealLoader(port, { path: "/drip", maxBytes: 1024 * 1024, totalTimeoutMs: 700 }),
      );
      assert(code === "TIMEOUT", `got ${code}`);
    },
  );
});

case_("a gzip body whose decoded size exceeds the cap is aborted", async () => {
  const bomb = gzipSync(Buffer.alloc(1024 * 1024, 0)); // 1 MB of zeros ≈ tiny compressed
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-length", String(bomb.byteLength));
      res.end(bomb);
    },
    async (port) => {
      const code = await errorCodeOf(
        driveRealLoader(port, { path: "/bomb", maxBytes: 64 * 1024, totalTimeoutMs: 5_000 }),
      );
      assert(code === "BODY_TOO_LARGE", `got ${code}`);
    },
  );
});

case_("a gzip body under the cap decodes correctly", async () => {
  const payload = Buffer.from("HUK radio: free, non-commercial, international.".repeat(10));
  const gz = gzipSync(payload);
  await withServer(
    (_req, res) => {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("content-length", String(gz.byteLength));
      res.end(gz);
    },
    async (port) => {
      const res = await driveRealLoader(port, { path: "/gz", maxBytes: 64 * 1024, totalTimeoutMs: 5_000 });
      assert(res.status === 200, `expected 200, got ${res.status}`);
      assert(Buffer.from(res.body!).equals(payload), "decoded body must match");
      assert(res.bytes === payload.byteLength, `decoded byte count must be the decoded size, got ${res.bytes}`);
    },
  );
});

case_("HEAD returns no body and reports the headers", async () => {
  await withServer(
    (_req, res) => {
      res.setHeader("etag", '"head-etag"');
      res.setHeader("content-length", "1234");
      res.end(); // HEAD: no body
    },
    async (port) => {
      const res = await driveRealLoader(port, {
        path: "/head",
        method: "HEAD",
        maxBytes: 64 * 1024,
        totalTimeoutMs: 5_000,
      });
      assert(res.status === 200 && res.headers.etag === '"head-etag"', "HEAD must return headers");
      assert(res.body === null && res.bytes === 0, "HEAD must have no body");
    },
  );
});

case_("chunked framing is decoded to the end", async () => {
  await withServer(
    (_req, res) => {
      // No content-length: node:http answers with chunked framing itself;
      // the pieces prove the client decodes chunk boundaries correctly.
      res.write("HUK!");
      res.write("42");
      res.end();
    },
    async (port) => {
      const res = await driveRealLoader(port, { path: "/chunked", maxBytes: 64 * 1024, totalTimeoutMs: 5_000 });
      assert(new TextDecoder().decode(res.body!) === "HUK!42", `unexpected chunked body: ${new TextDecoder().decode(res.body!)}`);
    },
  );
});

case_("trustedFetch rejects hosts outside the code-configured allowlist", async () => {
  const code = await errorCodeOf(trustedFetch("https://evil.example/api"));
  assert(code === "HOST_FORBIDDEN", `got ${code}`);
  assert(TRUSTED_HOSTS.has("api.acoustid.org"), "the allowlist must contain the fingerprint provider");
});
