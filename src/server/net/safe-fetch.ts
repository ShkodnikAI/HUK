// S4 (H-201) — the ONLY door for user-supplied URLs.
// safeFetch(url, opts): GET/HEAD, https only (a dev/test flag may allow
// http), userinfo rejected, port allowlist, self-resolved DNS with every
// address classified before any byte is sent, the connection PINNED to the
// validated address (SNI/Host keep the hostname) so DNS rebinding cannot
// swap it mid-flight, at most 3 redirects with every check re-run per hop,
// no cookies or credentials, connect + total timeouts, body aborted at
// maxBytes counting DECODED bytes (compression bombs die at the cap).
// Fail closed: any doubt is a typed SafeFetchError (S9).
//
// Transport: a minimal HTTP/1.1 client over node:tls / node:net. This is
// deliberate: it lets us pass the pinned address as the connect host while
// keeping the hostname as the TLS servername, it behaves the same under
// Node and under the Bun runtime used by the worker (no undici dispatcher
// there), and it adds no dependency. Limits are recorded in
// docs/adr/0008-safe-fetch.md.

import tls from "node:tls";
import net from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import type { Transform } from "node:stream";
import type { ZodType } from "zod";
import { loadEnv } from "@/server/env";

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "INSECURE_TRANSPORT"
  | "USERINFO_FORBIDDEN"
  | "PORT_FORBIDDEN"
  | "DNS_FAILED"
  | "PRIVATE_ADDRESS"
  | "HOST_FORBIDDEN"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_LOOP"
  | "CONNECT_TIMEOUT"
  | "TIMEOUT"
  | "BODY_TOO_LARGE"
  | "BAD_RESPONSE";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string) {
    super(`[safe-fetch:${code}] ${message}`);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

/** Injected/default DNS resolver: every address for the hostname. */
export type SafeResolver = (hostname: string) => Promise<string[]>;

export type SafeFetchResult = {
  status: number;
  headers: Record<string, string>; // lower-cased
  body: Uint8Array | null; // decoded; null for HEAD
  bytes: number; // decoded byte count
  url: string; // final URL after redirects
};

/** Injected/default transport: one request to ONE pinned address. */
export type SafeLoader = (req: {
  url: URL;
  pinnedAddress: string;
  hostname: string;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  maxBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
}) => Promise<SafeFetchResult>;

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  maxBytes?: number;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  portAllowlist?: number[];
  allowHttp?: boolean; // dev/test flag; default from SAFE_FETCH_ALLOW_HTTP
  maxHops?: number; // redirects, default 3
  sameHostOnly?: boolean; // a redirect may not leave the current host
  resolver?: SafeResolver;
  loader?: SafeLoader;
};

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_HOPS = 3;

// ───────────────── address classification ─────────────────

/** Expands an IPv6 literal into 8 16-bit groups (zone id stripped). */
function parseIPv6(ip: string): number[] | null {
  let s = ip;
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let head: string[], tail: string[];
  if (s.includes("::")) {
    const halves = s.split("::");
    if (halves.length > 2) return null;
    const [a, b] = halves;
    head = a ? a.split(":") : [];
    tail = b ? b.split(":") : [];
  } else {
    head = s.split(":");
    tail = [];
  }
  if (head.length + tail.length > 8) return null;
  const groups = new Array<number>(8).fill(0);
  const hex = /^[0-9a-f]{1,4}$/i;
  for (let i = 0; i < head.length; i++) {
    if (!hex.test(head[i])) return null;
    groups[i] = parseInt(head[i], 16);
  }
  const tailStart = 8 - tail.length;
  for (let i = 0; i < tail.length; i++) {
    if (!hex.test(tail[i])) return null;
    groups[tailStart + i] = parseInt(tail[i], 16);
  }
  return groups;
}

function classifyIPv4(b: number[]): "forbidden" | "allowed" {
  const [a, c] = b;
  // 0/8 unspecified ("this network"), 10/8 private, 100.64/10 CGNAT,
  // 127/8 loopback, 169.254/16 link-local (incl. the cloud metadata
  // 169.254.169.254), 172.16/12 private, 192.168/16 private, 224/4
  // multicast, 240/4 reserved (incl. 255.255.255.255 broadcast).
  if (a === 0 || a === 10 || a === 127 || a === 224 || a >= 240) return "forbidden";
  if (a === 169 && c === 254) return "forbidden";
  if (a === 172 && c >= 16 && c <= 31) return "forbidden";
  if (a === 192 && c === 168) return "forbidden";
  if (a === 100 && c >= 64 && c <= 127) return "forbidden";
  return "allowed";
}

function classifyIPv6(groups: number[]): "forbidden" | "allowed" {
  if (groups.every((g) => g === 0)) return "forbidden"; // :: unspecified
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return "forbidden"; // ::1 loopback
  if ((groups[0] & 0xfe00) === 0xfc00) return "forbidden"; // fc00::/7 ULA
  if ((groups[0] & 0xffc0) === 0xfe80) return "forbidden"; // fe80::/10 link-local
  if ((groups[0] & 0xff00) === 0xff00) return "forbidden"; // ff00::/8 multicast
  // ::ffff:0:0/96 (IPv4-mapped) and 64:ff9b::/96 (NAT64): classify the
  // embedded IPv4 so a forbidden v4 cannot sneak in as v6.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return classifyIPv4([(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff]);
  }
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return classifyIPv4([(groups[6] >> 8) & 0xff, groups[6] & 0xff, (groups[7] >> 8) & 0xff, groups[7] & 0xff]);
  }
  return "allowed";
}

/** True when the address must never be connected to (S4/S9: fail closed). */
export function isForbiddenAddress(address: string): boolean {
  const s = address.trim().replace(/%.*$/, ""); // strip an IPv6 zone id
  if (s.includes(":")) {
    const groups = parseIPv6(s);
    if (!groups) return true; // unparseable IPv6 → refuse
    return classifyIPv6(groups) === "forbidden";
  }
  const parts = s.split(".");
  if (parts.length !== 4) return true; // not a canonical dotted quad → refuse
  let ok = true;
  const bytes: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!/^\d{1,3}$/.test(p) || !Number.isInteger(n) || n < 0 || n > 255) ok = false;
    bytes.push(n);
  }
  if (!ok) return true;
  return classifyIPv4(bytes) === "forbidden";
}

// ───────────────── URL validation (per hop) ─────────────────

type ValidatedUrl = { url: URL; hostname: string; hostHeader: string; port: number };

function validateUrl(
  raw: string,
  opts: { allowHttp: boolean; ports: number[]; sameHostOnly?: boolean; previousHost?: string },
): ValidatedUrl {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("INVALID_URL", "not a valid URL");
  }
  // The WHATWG parser has already canonicalised odd IPv4 spellings (decimal,
  // hex, octal, short forms) and IPv6 zones in the host position, so the
  // classification below sees the real address. Anything it could not parse
  // as a host makes `new URL` throw.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SafeFetchError("INVALID_URL", `scheme ${url.protocol} is not http(s)`);
  }
  if (url.protocol === "http:" && !opts.allowHttp) {
    throw new SafeFetchError("INSECURE_TRANSPORT", "https only (S4); http requires the dev/test flag");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("USERINFO_FORBIDDEN", "userinfo in the URL is rejected");
  }
  if (opts.sameHostOnly && opts.previousHost && url.hostname.toLowerCase() !== opts.previousHost) {
    throw new SafeFetchError("HOST_FORBIDDEN", "redirect left the trusted host");
  }
  const explicitPort = url.port === "" ? null : Number(url.port);
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const port = explicitPort ?? defaultPort;
  const allowed = new Set<number>(opts.ports);
  if (opts.allowHttp) allowed.add(80);
  if (!allowed.has(port)) {
    throw new SafeFetchError("PORT_FORBIDDEN", `port ${port} is not in the allowlist`);
  }
  const hostname = url.hostname.toLowerCase();
  if (!hostname) throw new SafeFetchError("INVALID_URL", "empty hostname");
  const hostHeader =
    url.port === "" || Number(url.port) === defaultPort ? hostname : `${hostname}:${url.port}`;
  return { url, hostname, hostHeader, port };
}

// ───────────────── default resolver ─────────────────

const defaultResolver: SafeResolver = async (hostname) => {
  const { promises: dns } = await import("node:dns");
  const v6 = dns.resolve6(hostname).catch(() => [] as string[]);
  const v4 = dns.resolve4(hostname).catch(() => [] as string[]);
  const [a4, a6] = await Promise.all([v4, v6]);
  const all = [...a4, ...a6]; // IPv4 first: the pinned connect prefers it
  if (all.length === 0) throw new SafeFetchError("DNS_FAILED", `no addresses for ${hostname}`);
  return all;
};

// ───────────────── default loader (HTTP/1.1 over a pinned socket) ─────────────────

const HEAD_LIMIT = 64 * 1024;

class ByteCap extends Error {}

function defaultLoader(): SafeLoader {
  return pinnedTransportLoader;
}

/**
 * The real transport, exposed for tests: one request to ONE pinned
 * address over node:tls/node:net. Production always reaches it through
 * safeFetch's validation; tests may drive it directly against a local
 * server to prove streaming, caps and timeouts on real sockets.
 */
export function createDefaultLoader(): SafeLoader {
  return defaultLoader();
}

function pinnedTransportLoader(req: {
  url: URL;
  pinnedAddress: string;
  hostname: string;
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  maxBytes: number;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
}): Promise<SafeFetchResult> {
    const isHttps = req.url.protocol === "https:";
    const port = req.url.port === "" || Number.isNaN(Number(req.url.port)) ? (isHttps ? 443 : 80) : Number(req.url.port);
    const socket = isHttps
      ? tls.connect({
          host: req.pinnedAddress, // the PIN: connect to the validated address…
          port,
          servername: req.hostname, // …while SNI/cert verification keep the hostname
          ALPNProtocols: ["http/1.1"],
          rejectUnauthorized: true,
        })
      : net.connect({ host: req.pinnedAddress, port });

    let transportError: Error | null = null;
    let done = false;
    let resolveResult: (r: SafeFetchResult) => void = () => {};
    let rejectError: (e: Error) => void = () => {};
    const result = new Promise<SafeFetchResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectError = reject;
    });

    const connectTimer = setTimeout(
      () => settle(new SafeFetchError("CONNECT_TIMEOUT", `connect timed out after ${req.connectTimeoutMs}ms`)),
      req.connectTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => settle(new SafeFetchError("TIMEOUT", `total time budget ${req.totalTimeoutMs}ms exceeded`)),
      req.totalTimeoutMs,
    );

    function settle(err: Error): void {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      try {
        socket.destroy(err);
      } catch {
        /* already destroyed */
      }
      rejectError(err);
    }
    function finish(value: SafeFetchResult): void {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      try {
        socket.destroy();
      } catch {
        /* noop */
      }
      resolveResult(value);
    }

    socket.on("error", (e: Error) => {
      transportError = transportError ?? e;
      if (!done) settle(transportError);
    });

    const head =
      `${req.method} ${req.url.pathname}${req.url.search} HTTP/1.1\r\n` +
      Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("") +
      `Connection: close\r\n\r\n`;

    // Response state
    let headParsed = false;
    let status = 0;
    let headers: Record<string, string> = {};
    let framing: "none" | "content-length" | "chunked" | "to-eof" = "to-eof";
    let remaining = 0;
    let chunkRemaining = 0;
    let expectChunkStart = true;
    let decoder: Transform | null = null;
    let decoderEnded = false;
    const parts: Buffer[] = [];
    let total = 0;
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

    const sinkWrite = (chunk: Buffer): void => {
      total += chunk.byteLength;
      if (total > req.maxBytes) {
        throw new ByteCap();
      }
      parts.push(chunk);
    };
    const sinkTake = (): Uint8Array => {
      const out = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        out.set(p, off);
        off += p.byteLength;
      }
      return out;
    };

    function succeed(): void {
      // With a content-encoding decoder, the framing end is NOT the body end:
      // flush the decoder fully (and count its decoded bytes) first.
      if (decoder && !decoderEnded) {
        if (!decoder.writableEnded) decoder.end();
        return; // succeed() is re-invoked from the decoder 'end' handler
      }
      finish({
        status,
        headers,
        body: req.method === "HEAD" ? null : sinkTake(),
        bytes: total,
        url: req.url.href,
      });
    }

    function onDecoded(chunk: Buffer): void {
      try {
        sinkWrite(chunk);
      } catch (e) {
        if (e instanceof ByteCap) {
          settle(new SafeFetchError("BODY_TOO_LARGE", `decoded body exceeds ${req.maxBytes} bytes`));
          return;
        }
        settle(e instanceof Error ? e : new Error(String(e)));
      }
    }

    function feedBody(buf: Buffer): Buffer {
      let data = buf;
      while (data.length > 0 && !done) {
        if (framing === "chunked") {
          if (expectChunkStart) {
            // A terminator CRLF may arrive split from its chunk; skip it
            // before reading the next size line.
            if (data.length >= 2 && data[0] === 13 && data[1] === 10) {
              data = data.subarray(2);
            } else if (data.length === 1 && data[0] === 13) {
              return data; // need the LF to decide
            }
            const i = data.indexOf("\r\n");
            if (i < 0) return data; // wait for the rest of the size line
            const line = data.subarray(0, i).toString("latin1").split(";")[0].trim();
            const size = parseInt(line, 16);
            if (!Number.isInteger(size) || size < 0) {
              settle(new SafeFetchError("BAD_RESPONSE", "bad chunked size"));
              return Buffer.alloc(0);
            }
            data = data.subarray(i + 2);
            if (size === 0) {
              succeed(); // trailer bytes until close are ignored
              return Buffer.alloc(0);
            }
            chunkRemaining = size;
            expectChunkStart = false;
          } else {
            const take = Math.min(chunkRemaining, data.length);
            const piece = data.subarray(0, take);
            data = data.subarray(take);
            chunkRemaining -= take;
            if (chunkRemaining === 0) expectChunkStart = true;
            try {
              if (decoder) decoder.write(piece);
              else onDecoded(piece);
            } catch (e) {
              if (e instanceof ByteCap) {
                settle(new SafeFetchError("BODY_TOO_LARGE", `decoded body exceeds ${req.maxBytes} bytes`));
                return Buffer.alloc(0);
              }
              settle(e instanceof Error ? e : new Error(String(e)));
              return Buffer.alloc(0);
            }
            if (chunkRemaining === 0) {
              // consume the CRLF that terminates the chunk data
              if (data.length >= 2 && data[0] === 13 && data[1] === 10) data = data.subarray(2);
            }
          }
        } else if (framing === "content-length") {
          const take = Math.min(remaining, data.length);
          const piece = data.subarray(0, take);
          data = data.subarray(take);
          remaining -= take;
          try {
            if (decoder) decoder.write(piece);
            else onDecoded(piece);
          } catch (e) {
            if (e instanceof ByteCap) {
              settle(new SafeFetchError("BODY_TOO_LARGE", `decoded body exceeds ${req.maxBytes} bytes`));
              return Buffer.alloc(0);
            }
            settle(e instanceof Error ? e : new Error(String(e)));
            return Buffer.alloc(0);
          }
          if (remaining === 0) {
            succeed();
            return Buffer.alloc(0);
          }
        } else {
          // to-eof: everything counts, close ends the body
          try {
            if (decoder) decoder.write(data);
            else onDecoded(data);
          } catch (e) {
            if (e instanceof ByteCap) {
              settle(new SafeFetchError("BODY_TOO_LARGE", `decoded body exceeds ${req.maxBytes} bytes`));
              return Buffer.alloc(0);
            }
            settle(e instanceof Error ? e : new Error(String(e)));
            return Buffer.alloc(0);
          }
          data = Buffer.alloc(0);
        }
      }
      return data;
    }

    function parseHead(): void {
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx < 0) {
        if (buffer.length > HEAD_LIMIT) {
          settle(new SafeFetchError("BAD_RESPONSE", "response head too large"));
        }
        return; // wait for more bytes
      }
      const headBuf = buffer.subarray(0, idx);
      const rest = buffer.subarray(idx + 4);
      const lines = headBuf.toString("latin1").split("\r\n");
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0]);
      if (!m) {
        settle(new SafeFetchError("BAD_RESPONSE", "unparseable status line"));
        return;
      }
      status = Number(m[1]);
      headers = {};
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(":");
        if (c < 0) continue;
        headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
      }
      framing =
        req.method === "HEAD" || status === 204 || status === 304
          ? "none"
          : (headers["transfer-encoding"] ?? "").includes("chunked")
            ? "chunked"
            : headers["content-length"] !== undefined
              ? "content-length"
              : "to-eof";
      remaining = framing === "content-length" ? Number(headers["content-length"]) : 0;
      if (Number.isNaN(remaining)) {
        settle(new SafeFetchError("BAD_RESPONSE", "bad content-length"));
        return;
      }
      const encoding = (headers["content-encoding"] ?? "identity").toLowerCase();
      if (framing !== "none" && encoding !== "identity") {
        decoder =
          encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "deflate"
              ? createInflate()
              : encoding === "br"
                ? createBrotliDecompress()
                : null;
        if (!decoder) {
          settle(new SafeFetchError("BAD_RESPONSE", `unknown content-encoding: ${encoding}`));
          return;
        }
        decoder.on("data", (d: Buffer) => onDecoded(d));
        decoder.on("error", () => settle(new SafeFetchError("BAD_RESPONSE", "body decode failed")));
        decoder.on("end", () => {
          decoderEnded = true;
          succeed();
        });
      }
      headParsed = true;
      buffer = rest;
      if (framing === "none") {
        succeed();
        return;
      }
      buffer = feedBody(buffer);
    }

    socket.on("data", (chunk: Buffer<ArrayBufferLike>) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (!headParsed) {
        parseHead();
        if (done || !headParsed) return;
      }
      buffer = feedBody(buffer);
    });
    socket.on("close", () => {
      if (done) return;
      if (!headParsed) {
        settle(transportError ?? new SafeFetchError("BAD_RESPONSE", "connection closed before a response"));
        return;
      }
      if (framing === "to-eof" || (decoder && !decoderEnded)) {
        // to-eof: close IS the end; with a decoder, flush what remains.
        if (decoder && !decoderEnded) {
          decoder.end();
          return; // the decoder 'end' handler succeeds
        }
        succeed();
        return;
      }
      settle(new SafeFetchError("BAD_RESPONSE", "connection closed mid-body"));
    });

    const onConnected = (): void => {
      clearTimeout(connectTimer);
      try {
        socket.write(head);
      } catch (e) {
        settle(e instanceof Error ? e : new Error(String(e)));
      }
    };
    if (isHttps) socket.once("secureConnect", onConnected);
    else socket.once("connect", onConnected);

    return result;
}

// ───────────────── orchestration ─────────────────

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The single door for user-supplied URLs (S4). See the module header and
 * docs/adr/0008-safe-fetch.md. Tests may inject `resolver`/`loader`;
 * production uses default DNS resolution and the pinned HTTP/1.1 transport.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const env = loadEnv();
  const allowHttp = opts.allowHttp ?? env.SAFE_FETCH_ALLOW_HTTP;
  const ports = opts.portAllowlist ?? env.SAFE_FETCH_PORTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
  const resolver = opts.resolver ?? defaultResolver;
  const loader = opts.loader ?? defaultLoader();
  let method = opts.method ?? "GET";

  const first = validateUrl(rawUrl, { allowHttp, ports });
  const visited = new Set<string>([first.url.href]);
  let current: ValidatedUrl = first;

  for (let hop = 0; ; hop++) {
    // 1. resolve and classify EVERY address; any forbidden one kills the hop.
    const addresses = await resolver(current.hostname).catch((e) => {
      if (e instanceof SafeFetchError) throw e;
      throw new SafeFetchError("DNS_FAILED", `resolver failed for ${current.hostname}`);
    });
    if (addresses.length === 0) {
      throw new SafeFetchError("DNS_FAILED", `no addresses for ${current.hostname}`);
    }
    for (const address of addresses) {
      if (isForbiddenAddress(address)) {
        throw new SafeFetchError(
          "PRIVATE_ADDRESS",
          `${current.hostname} resolves to a forbidden address (${address})`,
        );
      }
    }
    const pinned = addresses[0];

    // 2. one request to the PINNED address; Host/SNI keep the hostname.
    const res = await loader({
      url: current.url,
      pinnedAddress: pinned,
      hostname: current.hostname,
      method,
      headers: {
        host: current.hostHeader,
        accept: "*/*",
        "user-agent": "HUK-safe-fetch/1",
        "accept-encoding": "gzip, deflate, br",
      },
      maxBytes,
      connectTimeoutMs,
      totalTimeoutMs,
    });

    // 3. redirects: every check re-runs on the next hop.
    const location = res.headers["location"];
    if (REDIRECT_STATUSES.has(res.status) && location) {
      if (hop >= maxHops) {
        throw new SafeFetchError("TOO_MANY_REDIRECTS", `more than ${maxHops} redirects`);
      }
      const nextRaw = new URL(location, current.url).href;
      const next = validateUrl(nextRaw, {
        allowHttp,
        ports,
        sameHostOnly: opts.sameHostOnly,
        previousHost: current.hostname,
      });
      if (visited.has(next.url.href)) {
        throw new SafeFetchError("REDIRECT_LOOP", `redirect loop at ${next.url.href}`);
      }
      visited.add(next.url.href);
      if (res.status !== 307 && res.status !== 308) method = "GET";
      current = next;
      continue;
    }

    return res;
  }
}

/** Validates a JSON schema against the (bounded) body — helper for callers. */
export function safeFetchJson<T>(result: SafeFetchResult, schema: ZodType<T>): T {
  const text = new TextDecoder().decode(result.body ?? new Uint8Array());
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SafeFetchError("BAD_RESPONSE", "body is not valid JSON");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new SafeFetchError("BAD_RESPONSE", "body does not match the schema");
  }
  return parsed.data;
}
