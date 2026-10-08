// The ranking job (H-304): leader-gated (the maintenance runner gates it),
// bounded (a batch of tracks per run), idempotent (recomputing the same
// events yields the same row). Recomputes TrackScore for categoryKey 'all'
// from likes, dislikes, playlist adds and verified listen events; writes
// ONLY APPROVED, available tracks. A nightly full pass recomputes all.

import { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";
import { scoreTrack, type RankedEvent } from "./signals";
import { runAntifraudPass, updateReputations } from "./antifraud";
import type { MaintenanceJob } from "@/server/maintenance/types";

const BATCH_TRACKS = 200;
/** Dedup key for completions: once per user per UTC day. */
function completionDedupKey(userId: string | null, anonHash: string | null, createdAt: Date): string {
  const actor = userId ?? `anon:${anonHash ?? "unknown"}`;
  return `${actor}:${createdAt.toISOString().slice(0, 10)}`;
}

export async function recomputeTrackScores(
  trackIds: string[],
  nowMs: number,
  seam: { client?: PrismaClient } = {},
): Promise<number> {
  const client = seam.client ?? defaultDb;
  if (trackIds.length === 0) return 0;

  const tracks = await client.track.findMany({
    where: { id: { in: trackIds }, status: "APPROVED", available: true },
    select: { id: true },
  });
  const eligibleIds = new Set(tracks.map((t) => t.id));

  let written = 0;
  for (const trackId of eligibleIds) {
    const [reactions, playlistAdds, listens, flags] = await Promise.all([
      client.reaction.findMany({
        where: { trackId },
        select: { userId: true, type: true, createdAt: true, user: { select: { reputation: true } } },
      }),
      client.playlistItem.findMany({
        where: { trackId, playlist: { visibility: { not: "PRIVATE" } } },
        select: { addedAt: true, playlist: { select: { ownerId: true } } },
      }),
      client.listenEvent.findMany({
        where: { trackId },
        select: { userId: true, anonHash: true, completed: true, skippedEarly: true, mode: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      }),
      client.voteFlag.findMany({ where: { trackId }, select: { userId: true, reason: true } }),
    ]);

    const flaggedPairs = new Set(flags.map((f) => `${f.userId}:${f.reason}`));
    const events: RankedEvent[] = [];

    for (const reaction of reactions) {
      events.push({
        type: reaction.type,
        reputation: reaction.user.reputation,
        ageMs: Math.max(0, nowMs - reaction.createdAt.getTime()),
        actorId: reaction.userId,
        flagged: flaggedPairs.has(`${reaction.userId}:vote-burst`) || flaggedPairs.has(`${reaction.userId}:ip-cluster`),
      });
    }

    for (const add of playlistAdds) {
      events.push({
        type: "PLAYLIST_ADD",
        reputation: 1.0, // playlist adds carry the default trust; anti-fraud flags cover votes only
        ageMs: Math.max(0, nowMs - add.addedAt.getTime()),
        actorId: add.playlist.ownerId,
      });
    }

    // Completions: once per user per UTC day; a completion on ANOTHER day
    // is a repeat completion. Anonymous events count with default trust.
    const seenCompletions = new Set<string>();
    const completionDays = new Map<string, Set<string>>();
    for (const listen of listens) {
      const actor = listen.userId ?? `anon:${listen.anonHash ?? "unknown"}`;
      if (listen.completed) {
        const key = completionDedupKey(listen.userId, listen.anonHash, listen.createdAt);
        const days = completionDays.get(actor) ?? new Set<string>();
        const isRepeat = days.has("*") && !seenCompletions.has(key);
        if (!seenCompletions.has(key)) {
          seenCompletions.add(key);
          days.add("*");
          completionDays.set(actor, days);
          const priorCompletions = [...seenCompletions].filter((k) => k.startsWith(actor)).length;
          events.push({
            type: priorCompletions > 1 ? "REPEAT_COMPLETION" : "COMPLETION",
            reputation: 1.0,
            ageMs: Math.max(0, nowMs - listen.createdAt.getTime()),
            actorId: actor,
          });
        }
      } else if (listen.skippedEarly && listen.mode === "PLAYLIST") {
        events.push({
          type: "EARLY_SKIP_PLAYLIST",
          reputation: 1.0,
          ageMs: Math.max(0, nowMs - listen.createdAt.getTime()),
          actorId: actor,
        });
      }
    }
    const result = scoreTrack(events);
    await client.trackScore.upsert({
      where: { trackId_categoryKey: { trackId, categoryKey: "all" } },
      create: { trackId, categoryKey: "all", score: result.score, nEff: result.nEff, voters: result.voters },
      update: { score: result.score, nEff: result.nEff, voters: result.voters },
    });
    written++;
  }
  return written;
}

/** Tracks whose signals changed since their score row was last written. */
async function staleTrackIds(client: PrismaClient, limit: number): Promise<string[]> {
  const rows = await client.$queryRaw<Array<{ id: string }>>`
    SELECT t."id" FROM "Track" t
    WHERE t."status" = 'APPROVED' AND t."available" = true
      AND (
        NOT EXISTS (SELECT 1 FROM "TrackScore" s WHERE s."trackId" = t."id" AND s."categoryKey" = 'all')
        OR EXISTS (
          SELECT 1 FROM (
            SELECT MAX(r."createdAt") AS last FROM "Reaction" r WHERE r."trackId" = t."id"
            UNION ALL
            SELECT MAX(li."addedAt") FROM "PlaylistItem" li WHERE li."trackId" = t."id"
            UNION ALL
            SELECT MAX(le."createdAt") FROM "ListenEvent" le WHERE le."trackId" = t."id"
          ) latest
          WHERE latest."last" IS NOT NULL
            AND latest."last" > COALESCE(
              (SELECT s."updatedAt" FROM "TrackScore" s WHERE s."trackId" = t."id" AND s."categoryKey" = 'all'),
              t."createdAt" - interval '100 years'
            )
        )
      )
    LIMIT ${limit}
  `;
  return rows.map((r) => r.id);
}

export function makeRankingJobs(seam: { client?: PrismaClient } = {}): MaintenanceJob[] {
  const client = seam.client ?? defaultDb;
  return [
    {
      name: "ranking-recompute",
      everyMs: 10 * 60 * 1000,
      run: async () => {
        const ids = await staleTrackIds(client, BATCH_TRACKS);
        const written = await recomputeTrackScores(ids, Date.now(), { client });
        return `${written} tracks rescored (${ids.length} stale, bounded ${BATCH_TRACKS})`;
      },
    },
    {
      name: "antifraud-pass",
      everyMs: 24 * 60 * 60 * 1000,
      run: async () => {
        const result = await runAntifraudPass({ client });
        const reputations = await updateReputations({ client });
        return `${result.newFlags} new flags (checked ${result.checked}), ${reputations} reputations updated`;
      },
    },
    {
      name: "ranking-full",
      everyMs: 24 * 60 * 60 * 1000,
      run: async () => {
        let written = 0;
        for (;;) {
          const ids = await staleTrackIds(client, BATCH_TRACKS);
          if (ids.length === 0) break;
          written += await recomputeTrackScores(ids, Date.now(), { client });
          if (ids.length < BATCH_TRACKS) break;
        }
        return `${written} tracks rescored (full pass)`;
      },
    },
  ];
}
