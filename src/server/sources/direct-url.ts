// Direct-URL source probing (H-202): an author-supplied https URL is
// validated through safeFetch (S4) with a HEAD request, falling back to a
// ranged GET when the server does not support HEAD. Content type is
// advisory only — HUK stores links and hashes, never user audio (ADR-0002).

import { safeFetch, SafeFetchError, type SafeLoader } from "@/server/net/safe-fetch";

export type DirectUrlProbe = {
  etag: string | null;
  byteLength: bigint | null;
  contentType: string | null; // advisory only
  acceptsRanges: boolean;
};

function totalFromContentRange(value: string | undefined): bigint | null {
  if (!value) return null;
  const total = value.split("/")[1];
  if (!total || total === "*") return null;
  const n = Number(total);
  return Number.isInteger(n) && n >= 0 ? BigInt(n) : null;
}

/**
 * Probes the URL. `loader`/`resolver`/`portAllowlist` are the H-201 test
 * seams; production always uses the pinned transport.
 */
export async function probeDirectUrl(
  rawUrl: string,
  opts?: {
    loader?: SafeLoader;
    resolver?: (hostname: string) => Promise<string[]>;
    portAllowlist?: number[];
    connectTimeoutMs?: number;
    totalTimeoutMs?: number;
  },
): Promise<DirectUrlProbe> {
  const shared = {
    loader: opts?.loader,
    resolver: opts?.resolver,
    portAllowlist: opts?.portAllowlist,
    connectTimeoutMs: opts?.connectTimeoutMs,
    totalTimeoutMs: opts?.totalTimeoutMs,
  };

  // 1. HEAD first.
  let head: Awaited<ReturnType<typeof safeFetch>> | null = null;
  try {
    head = await safeFetch(rawUrl, { method: "HEAD", ...shared });
  } catch (e) {
    // Transport-level HEAD failures propagate (they count as source
    // failures); only a non-200 answer falls through to the ranged GET.
    if (e instanceof SafeFetchError) throw e;
    throw e;
  }
  if (head.status === 200) {
    return {
      etag: head.headers.etag ?? null,
      byteLength:
        head.headers["content-length"] !== undefined
          ? BigInt(head.headers["content-length"])
          : totalFromContentRange(head.headers["content-range"]),
      contentType: head.headers["content-type"] ?? null,
      acceptsRanges: (head.headers["accept-ranges"] ?? "").includes("bytes"),
    };
  }

  // 2. Ranged GET fallback (e.g. HEAD unsupported): one byte, total from
  // Content-Range.
  const res = await safeFetch(rawUrl, {
    method: "GET",
    maxBytes: 4096,
    headers: { range: "bytes=0-0" },
    ...shared,
  });
  if (res.status !== 206 && res.status !== 200) {
    throw new SafeFetchError("BAD_RESPONSE", `probe answered ${res.status}`);
  }
  return {
    etag: res.headers.etag ?? null,
    byteLength:
      totalFromContentRange(res.headers["content-range"]) ??
      (res.headers["content-length"] !== undefined && res.status === 200
        ? BigInt(res.headers["content-length"])
        : null),
    contentType: res.headers["content-type"] ?? null,
    acceptsRanges: (res.headers["accept-ranges"] ?? "").includes("bytes"),
  };
}
