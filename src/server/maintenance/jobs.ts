// The concrete maintenance job set (H-210, S7). Every job is:
// - idempotent: re-running it changes nothing (aggregation+deletion is one
//   atomic statement; the rest are plain bounded deletes/strips);
// - bounded per run: each pass touches at most `batchSize` rows — the
//   purge jobs delete in batches of `batchSize` rows per statement, at most
//   MAX_PURGE_BATCHES statements per run (H-213, G6: a huge backlog cannot
//   lock the table; the next run drains the rest);
// - audited: the runner writes one AuditLog row per run with the counts.

import type { PrismaClient } from "@prisma/client";
import { loadEnv } from "@/server/env";
import { db as defaultDb } from "@/server/db";
import type { MaintenanceJob } from "./types";
import { verifyTrackSource } from "@/server/sources/verify";
import { closeStaleSessions } from "@/server/listen/session";

const HOURLY_MS = 60 * 60 * 1000;
const DAILY_MS = 24 * HOURLY_MS;
const MONTHLY_MS = 30 * DAILY_MS;
const TEN_MINUTES_MS = 10 * 60 * 1000;
/** ARCHITECTURE §4: AuditLog is kept for 24 months. */
const AUDIT_RETENTION_MONTHS = 24;
/** H-213 (G6): at most this many batched DELETE statements per job run. */
const MAX_PURGE_BATCHES = 20;

/**
 * H-213 (G6): bounded batched delete. Selects one batch of rows, deletes
 * exactly those rows, repeats — at most MAX_PURGE_BATCHES times. Generic
 * over the batch row shape (VerificationToken has a composite key, so the
 * selector carries whatever columns the delete filter needs). Returns the
 * total removed so the audit entry keeps the real count.
 */
async function batchedDelete<B>(
  selectBatch: () => Promise<B[]>,
  remove: (batch: B[]) => Promise<number>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_PURGE_BATCHES; batch++) {
    const rows = await selectBatch();
    if (rows.length === 0) break;
    total += await remove(rows);
    if (rows.length < batchSize) break; // the backlog is drained
  }
  return total;
}

/** Payload keys that carry unbounded ASR/transcript text (S7 retention). */
const TRANSCRIPT_KEYS = ["transcript", "transcripts", "asrText", "asrSegments"] as const;

export function makeMaintenanceJobs(
  client: PrismaClient = defaultDb,
  opts?: { listenBatchSize?: number; transcriptBatchSize?: number; auditBatchSize?: number; purgeBatchSize?: number },
): MaintenanceJob[] {
  const listenBatchSize = opts?.listenBatchSize ?? 10_000;
  const transcriptBatchSize = opts?.transcriptBatchSize ?? 500;
  const auditBatchSize = opts?.auditBatchSize ?? 5_000;
  // H-213 (G6): batch size for the bucket/session/token purge statements.
  const purgeBatchSize = opts?.purgeBatchSize ?? 1_000;

  return [
    {
      name: "purge-rate-limit-buckets",
      everyMs: HOURLY_MS,
      run: async () => {
        const removed = await batchedDelete(
          () =>
            client.rateLimitBucket.findMany({
              where: { windowStart: { lt: new Date() } },
              orderBy: { windowStart: "asc" },
              take: purgeBatchSize,
              // composite key (key, windowStart) — no surrogate id column
              select: { key: true, windowStart: true },
            }),
          (rows) =>
            client.rateLimitBucket
              .deleteMany({ where: { OR: rows.map((r) => ({ key: r.key, windowStart: r.windowStart })) } })
              .then((r) => r.count),
          purgeBatchSize,
        );
        return `${removed} expired buckets removed`;
      },
    },
    {
      name: "purge-expired-sessions",
      everyMs: HOURLY_MS,
      run: async () => {
        const sessions = await batchedDelete(
          () =>
            client.session.findMany({
              where: { expires: { lt: new Date() } },
              orderBy: { expires: "asc" },
              take: purgeBatchSize,
              select: { id: true },
            }),
          (rows) => client.session.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).then((r) => r.count),
          purgeBatchSize,
        );
        const tokens = await batchedDelete(
          () =>
            client.verificationToken.findMany({
              where: { expires: { lt: new Date() } },
              take: purgeBatchSize,
              // composite key (identifier, token) — no surrogate id column
              select: { identifier: true, token: true },
            }),
          (rows) =>
            client.verificationToken
              .deleteMany({
                where: { OR: rows.map((r) => ({ identifier: r.identifier, token: r.token })) },
              })
              .then((r) => r.count),
          purgeBatchSize,
        );
        return `${sessions} sessions, ${tokens} verification tokens removed`;
      },
    },
    {
      name: "aggregate-listen-events",
      everyMs: DAILY_MS,
      run: async () => {
        const env = loadEnv();
        const cutoff = new Date(Date.now() - env.RETENTION_LISTEN_EVENTS_DAYS * 24 * 60 * 60 * 1000);
        // One atomic statement: aggregate the oldest batch into per-track
        // per-day sums (upsert), then delete exactly those rows. Atomic =
        // idempotent: a partial run cannot double-count or lose rows.
        const deleted = await client.$executeRaw`
          WITH batch AS (
            SELECT "id", "trackId", date_trunc('day', "createdAt") AS "day",
                   "msListened", "completed", "skippedEarly"
              FROM "ListenEvent"
             WHERE "createdAt" < ${cutoff}
             ORDER BY "createdAt"
             LIMIT ${listenBatchSize}
          ), agg AS (
            SELECT "trackId", "day",
                   COUNT(*)::bigint AS "plays",
                   COALESCE(SUM("msListened"), 0)::bigint AS "ms",
                   COALESCE(SUM(CASE WHEN "completed" THEN 1 ELSE 0 END), 0)::bigint AS "completions",
                   COALESCE(SUM(CASE WHEN "skippedEarly" THEN 1 ELSE 0 END), 0)::bigint AS "skips"
              FROM batch
             GROUP BY "trackId", "day"
          ), upsert AS (
            INSERT INTO "ListenAggregate" ("trackId", "day", "plays", "msListened", "completions", "skips")
            SELECT "trackId", "day", "plays", "ms", "completions", "skips" FROM agg
            ON CONFLICT ("trackId", "day") DO UPDATE SET
              "plays" = "ListenAggregate"."plays" + EXCLUDED."plays",
              "msListened" = "ListenAggregate"."msListened" + EXCLUDED."msListened",
              "completions" = "ListenAggregate"."completions" + EXCLUDED."completions",
              "skips" = "ListenAggregate"."skips" + EXCLUDED."skips"
            RETURNING 1
          )
          DELETE FROM "ListenEvent" WHERE "id" IN (SELECT "id" FROM batch)
        `;
        return `${deleted} listen events aggregated and removed`;
      },
    },
    {
      name: "purge-transcripts",
      everyMs: DAILY_MS,
      run: async () => {
        const env = loadEnv();
        const cutoff = new Date(Date.now() - env.RETENTION_TRANSCRIPTS_DAYS * 24 * 60 * 60 * 1000);
        // Strip only the unbounded text fields; the verdict, confidence and
        // cost stay (the row remains the audit trail of the decision).
        const minusExpr = TRANSCRIPT_KEYS.map((k) => `- '${k}'`).join(" ");
        const keysLiteral = TRANSCRIPT_KEYS.map((k) => `'${k}'`).join(", ");
        const stripped = await client.$executeRawUnsafe(
          `UPDATE "ModerationRun"
              SET "payload" = "payload" ${minusExpr}
            WHERE "id" IN (
              SELECT "id" FROM "ModerationRun"
               WHERE "createdAt" < $1 AND "payload" ?| ARRAY[${keysLiteral}]::text[]
               LIMIT $2
          )`,
          cutoff,
          transcriptBatchSize,
        );
        return `${stripped} moderation payloads stripped of transcripts (verdicts kept)`;
      },
    },
    {
      name: "purge-audit-log",
      everyMs: MONTHLY_MS,
      run: async () => {
        const cutoff = new Date(Date.now() - AUDIT_RETENTION_MONTHS * 30 * 24 * 60 * 60 * 1000);
        // H-213 (G6): batched — a 24-month-old backlog cannot lock the table.
        const removed = await batchedDelete(
          () =>
            client.auditLog.findMany({
              where: { createdAt: { lt: cutoff } },
              orderBy: { createdAt: "asc" },
              take: auditBatchSize,
              select: { id: true },
            }),
          (rows) => client.auditLog.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).then((r) => r.count),
          auditBatchSize,
        );
        return `${removed} audit entries older than ${AUDIT_RETENTION_MONTHS} months removed`;
      },
    },
    {
      name: "listen-sessions",
      everyMs: TEN_MINUTES_MS,
      run: async () => {
        // H-301 (S7): close sessions whose beat loop vanished (no beat for
        // 60 s — each writes exactly one ListenEvent), then purge closed
        // sessions 48 h after closing in bounded batches (G6).
        const closed = await closeStaleSessions({ client });
        const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000);
        const removed = await batchedDelete(
          () =>
            client.listenSession.findMany({
              where: { closedAt: { lt: cutoff } },
              orderBy: { closedAt: "asc" },
              take: purgeBatchSize,
              select: { id: true },
            }),
          (rows) => client.listenSession.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } }).then((r) => r.count),
          purgeBatchSize,
        );
        return `${closed} stale sessions closed, ${removed} closed sessions purged`;
      },
    },
    {
      name: "verify-track-sources",
      everyMs: TEN_MINUTES_MS,
      run: async () => {
        const env = loadEnv();
        // Oldest verifiedAt first; never-verified sources (NULL) go first.
        const ids = await client.$queryRaw<Array<{ trackId: string }>>`
          SELECT "trackId" FROM "TrackSource"
          WHERE "provider" != 'SEED' OR "verifiedAt" IS NULL
          ORDER BY "verifiedAt" ASC NULLS FIRST
          LIMIT ${env.SOURCE_VERIFY_BATCH}
        `;
        let fresh = 0, mismatched = 0, unavailable = 0, skipped = 0;
        for (const { trackId } of ids) {
          const outcome = await verifyTrackSource(trackId, { client, env });
          if (outcome.outcome === "fresh") fresh++;
          else if (outcome.outcome === "mismatch") mismatched++;
          else if (outcome.outcome === "unavailable") unavailable++;
          else skipped++;
        }
        return `${ids.length} sources checked: ${fresh} fresh, ${mismatched} mismatched, ${unavailable} unavailable, ${skipped} skipped`;
      },
    },
  ];
}
