// Source verification (H-202): the worker keeps every track source honest.
// - cheap check: HEAD/ranged probe compares ETag and byte length;
// - scheduled full check: a complete download and SHA-256 every
//   SOURCE_FULL_HASH_DAYS (default 7);
// - a mismatch suspends the track (SUSPENDED) and queues re-moderation as a
//   ModerationRun(REVIEW) note — the track is never silently dropped;
// - transport failures increment failCount; at SOURCE_MAX_FAILS the source
//   becomes unavailable (available = false); a success resets the counter;
// - fetchForModeration streams the file into a 0700 temp directory and the
//   caller's cleanup runs in finally (S3: no persistent copy of user audio).
// All outbound traffic goes through safeFetch (S4); `loader`/`resolver` are
// the H-201 test seams (local fake hosts), never a production flag.

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadEnv, type Env } from "@/server/env";
import { db as defaultDb } from "@/server/db";
import { audit } from "@/server/audit";
import { HttpError } from "@/server/http/errors";
import { safeFetch, SafeFetchError, type SafeLoader, type SafeResolver } from "@/server/net/safe-fetch";
import { probeDirectUrl } from "./direct-url";

export type VerifySeam = {
  loader?: SafeLoader;
  resolver?: SafeResolver;
  portAllowlist?: number[];
  client?: PrismaClient;
  env?: Pick<Env, "SOURCE_FULL_HASH_DAYS" | "SOURCE_MAX_FAILS" | "AUDIUS_ENABLED">;
  now?: () => number;
};

export type VerifyOutcome =
  | { outcome: "fresh"; etag: string | null; byteLength: bigint | null; fullHash: string | null }
  | { outcome: "mismatch"; detail: string }
  | { outcome: "unavailable"; failCount: number }
  | { outcome: "skipped"; detail: string };

const FETCH_CAP_BYTES = 512 * 1024 * 1024; // moderation download cap (S6-adjacent bound)

function isTransportFailure(e: unknown): boolean {
  if (e instanceof SafeFetchError) {
    return ![
      "BODY_TOO_LARGE",
      "INVALID_URL",
      "INSECURE_TRANSPORT",
      "USERINFO_FORBIDDEN",
      "PORT_FORBIDDEN",
      "HOST_FORBIDDEN",
      "TOO_MANY_REDIRECTS",
      "REDIRECT_LOOP",
    ].includes(e.code);
  }
  // Raw socket errors from the pinned transport (ECONNREFUSED, ETIMEDOUT…)
  const code = (e as { code?: string }).code;
  return (
    typeof code === "string" &&
    /^(ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPROTO|ECONNABORTED|EPIPE)$/.test(code)
  );
}

async function downloadAndHash(
  url: string,
  seam: VerifySeam & { maxBytes?: number },
  onAbort?: (bytesSoFar: number) => void,
): Promise<{ sha256: string; bytes: number }> {
  const res = await safeFetch(url, {
    method: "GET",
    maxBytes: seam.maxBytes ?? FETCH_CAP_BYTES,
    loader: seam.loader,
    resolver: seam.resolver,
    portAllowlist: seam.portAllowlist,
    totalTimeoutMs: 60_000,
  });
  const hash = createHash("sha256").update(res.body ?? new Uint8Array()).digest("hex");
  return { sha256: hash, bytes: res.bytes };
}

/**
 * Verifies one track source. Never throws for source-level conditions —
 * those become outcomes; unexpected errors (DB etc.) propagate.
 */
export async function verifyTrackSource(trackId: string, seam: VerifySeam = {}): Promise<VerifyOutcome> {
  const client = seam.client ?? defaultDb;
  const env = seam.env ?? loadEnv();
  const now = seam.now ?? Date.now;

  const track = await client.track.findUnique({ where: { id: trackId }, include: { source: true } });
  if (!track?.source) {
    throw new HttpError(404, "SOURCE_NOT_FOUND", `no source for track ${trackId}`);
  }
  const source = track.source;

  // SEED tracks are hosted by us; there is nothing remote to verify.
  if (source.provider === "SEED") {
    await client.trackSource.update({ where: { id: source.id }, data: { verifiedAt: new Date(), failCount: 0 } });
    return { outcome: "fresh", etag: source.etag, byteLength: source.byteLength, fullHash: source.contentHash };
  }

  // The Audius provider is disabled by default (D3): skip, never verify
  // against an unconsented provider.
  if (source.provider === "AUDIUS" && !env.AUDIUS_ENABLED) {
    return { outcome: "skipped", detail: "AUDIUS_ENABLED=false (D3 pending)" };
  }

  try {
    const probe = await probeDirectUrl(source.url, {
      loader: seam.loader,
      resolver: seam.resolver,
      portAllowlist: seam.portAllowlist,
    });

    // Cheap mismatch: ETag or length diverged from the recorded source.
    const lengthChanged =
      probe.byteLength !== null && source.byteLength !== null && probe.byteLength !== source.byteLength;
    const etagChanged = probe.etag !== null && source.etag !== null && probe.etag !== source.etag;
    if (lengthChanged || etagChanged) {
      const detail = `source changed: etag ${source.etag ?? "-"} -> ${probe.etag ?? "-"}, length ${source.byteLength ?? "-"} -> ${probe.byteLength ?? "-"}`;
      await client.$transaction([
        client.track.update({ where: { id: trackId }, data: { status: "SUSPENDED" } }),
        client.moderationRun.create({
          data: {
            trackId,
            stage: "TECHNICAL",
            verdict: "REVIEW",
            payload: { note: "source verification mismatch", detail },
          },
        }),
      ]);
      await audit({
        actorKind: "worker",
        action: "source.mismatch",
        targetType: "Track",
        targetId: trackId,
        payload: { detail },
      });
      return { outcome: "mismatch", detail };
    }

    // Scheduled full hash: when the content hash is missing or stale.
    const fullDue =
      source.contentHash === null ||
      source.verifiedAt === null ||
      now() - source.verifiedAt.getTime() >= env.SOURCE_FULL_HASH_DAYS * 24 * 60 * 60 * 1000;
    let fullHash: string | null = null;
    if (fullDue) {
      const dl = await downloadAndHash(source.url, seam);
      fullHash = dl.sha256;
      if (source.contentHash !== null && source.contentHash !== dl.sha256) {
        // Content changed without ETag/length moving (or a stale schedule).
        const detail = "full hash mismatch: content changed";
        await client.$transaction([
          client.track.update({ where: { id: trackId }, data: { status: "SUSPENDED" } }),
          client.moderationRun.create({
            data: {
              trackId,
              stage: "TECHNICAL",
              verdict: "REVIEW",
              payload: { note: "source verification mismatch", detail },
            },
          }),
        ]);
        await audit({
          actorKind: "worker",
          action: "source.mismatch",
          targetType: "Track",
          targetId: trackId,
          payload: { detail },
        });
        return { outcome: "mismatch", detail };
      }
    }

    await client.trackSource.update({
      where: { id: source.id },
      data: {
        verifiedAt: new Date(),
        failCount: 0,
        etag: probe.etag ?? source.etag,
        byteLength: probe.byteLength ?? source.byteLength,
        contentHash: fullHash ?? source.contentHash,
        lastError: null,
      },
    });
    // A success also heals a source that had failed out (counter reset
    // implies the transport works again).
    if (!track.available) {
      await client.track.update({ where: { id: trackId }, data: { available: true } });
    }
    return { outcome: "fresh", etag: probe.etag, byteLength: probe.byteLength, fullHash };
  } catch (e) {
    if (!isTransportFailure(e)) throw e;
    const message = e instanceof Error ? e.message : String(e);
    const failCount = source.failCount + 1;
    const unavailable = failCount >= env.SOURCE_MAX_FAILS;
    await client.trackSource.update({
      where: { id: source.id },
      data: { failCount, lastError: message.slice(0, 500) },
    });
    if (unavailable) {
      await client.track.update({ where: { id: trackId }, data: { available: false } });
      await audit({
        actorKind: "worker",
        action: "source.unavailable",
        targetType: "Track",
        targetId: trackId,
        payload: { failCount, lastError: message.slice(0, 200) },
      });
    }
    return { outcome: "unavailable", failCount };
  }
}

// ("source not found" is an HttpError 404 — not a transport failure)

// ───────────────── moderation download (S3) ─────────────────

const TEMP_PREFIX = "huk-mod-";
const TEMP_STALE_MS = 60 * 60 * 1000;

export type ModerationFile = { path: string; sha256: string; bytes: number };

/**
 * Downloads the track source into a PRIVATE temp directory (mode 0700) and
 * hands `{ path, sha256, bytes }` to `fn`; the file is removed in `finally`
 * on success, on error and on abort (S3: no persistent copy of user audio).
 */
export async function withModerationFile<T>(
  trackId: string,
  fn: (file: ModerationFile) => Promise<T>,
  seam: VerifySeam & { maxBytes?: number } = {},
): Promise<T> {
  // mkdtempSync already creates the directory with mode 0700 (private, S3).
  const dir = mkdtempSync(join(tmpdir(), TEMP_PREFIX));
  const filePath = join(dir, "source.bin");
  try {
    const track = await (seam.client ?? defaultDb).track.findUnique({
      where: { id: trackId },
      include: { source: true },
    });
    if (!track?.source) {
      throw new HttpError(404, "SOURCE_NOT_FOUND", `no source for track ${trackId}`);
    }
    const res = await safeFetch(track.source.url, {
      method: "GET",
      maxBytes: seam.maxBytes ?? FETCH_CAP_BYTES,
      loader: seam.loader,
      resolver: seam.resolver,
      portAllowlist: seam.portAllowlist,
      totalTimeoutMs: 60_000,
    });
    const body = res.body ?? new Uint8Array();
    const sha256 = createHash("sha256").update(body).digest("hex");
    const fd = openSync(filePath, "w", 0o600);
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return await fn({ path: filePath, sha256, bytes: body.byteLength });
  } finally {
    try {
      if (existsSync(filePath)) rmSync(filePath, { force: true });
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; the sweep catches the rest */
    }
  }
}

/** Start-up sweep: removes temp dirs left behind by a crashed worker (S3). */
export function sweepStaleTempFiles(maxAgeMs: number = TEMP_STALE_MS): number {
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = readdirSync(tmpdir()).filter((e) => e.startsWith(TEMP_PREFIX));
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(tmpdir(), entry);
    try {
      const age = Date.now() - statSync(full).mtimeMs;
      if (age > maxAgeMs) {
        rmSync(full, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* already gone */
    }
  }
  return removed;
}

export { downloadAndHash };
