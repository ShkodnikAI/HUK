// The ranking job (H-304, extended by H-305): leader-gated (the
// maintenance runner gates it), bounded (a batch of tracks per run),
// idempotent (recomputing the same events yields the same row). Recomputes
// TrackScore from likes, dislikes, playlist adds and verified listen
// events; writes ONLY APPROVED, available tracks. H-305: the score is
// written for every chart category the track belongs to (all, lang:<code>,
// style:<slug>, direction:<slug>, instrumental, lang+style combos) and
// rows for categories the track left are deleted; a daily reconcile job
// recomputes tracks whose category set no longer matches their confirmed
// terms (moderator SET_TERMS). The weekly chart snapshot rides the same
// gated runner (src/server/charts/service.ts).

import { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";
import { scoreTrack, type RankedEvent } from "./signals";
import { runAntifraudPass, updateReputations } from "./antifraud";
import { categoryKeysForTrack } from "@/server/charts/categories";
import { ensureWeeklySnapshots } from "@/server/charts/service";
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
    select: { id: true, language: true, instrumental: true },
  });
  const eligible = new Map(tracks.map((t) => [t.id, t]));
  const trackIdsEligible = [...eligible.keys()];

  // H-305: the confirmed terms drive the chart categories (lang/style/
  // direction); loaded once for the whole batch.
  const termRows = trackIdsEligible.length
    ? await client.trackTerm.findMany({
        where: { trackId: { in: trackIdsEligible }, confirmed: true },
        select: { trackId: true, term: { select: { kind: true, slug: true } } },
      })
    : [];
  const termsByTrack = new Map<string, Array<{ kind: "LANGUAGE" | "STYLE" | "DIRECTION"; slug: string }>>();
  for (const row of termRows) {
    const list = termsByTrack.get(row.trackId) ?? [];
    list.push({ kind: row.term.kind, slug: row.term.slug });
    termsByTrack.set(row.trackId, list);
  }

  let written = 0;
  for (const trackId of trackIdsEligible) {
    const shape = eligible.get(trackId)!;
    const categoryKeys = categoryKeysForTrack({
      language: shape.language,
      instrumental: shape.instrumental,
      terms: termsByTrack.get(trackId) ?? [],
    });
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
    for (const categoryKey of categoryKeys) {
      await client.trackScore.upsert({
        where: { trackId_categoryKey: { trackId, categoryKey } },
        create: { trackId, categoryKey, score: result.score, nEff: result.nEff, voters: result.voters },
        update: { score: result.score, nEff: result.nEff, voters: result.voters },
      });
    }
    // Rows for categories the track left (terms changed) go away.
    await client.trackScore.deleteMany({
      where: { trackId, categoryKey: { notIn: categoryKeys } },
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

  /**
   * H-305: tracks whose score-row category set no longer matches their
   * confirmed terms (a moderator SET_TERMS adds or removes categories).
   * App-side comparison — the language key uses the same derivation as the
   * submission path, so the check is exact.
   */
  async function categoryMismatchedTrackIds(): Promise<string[]> {
    const tracks = await client.track.findMany({
      where: { status: "APPROVED", available: true },
      select: { id: true, language: true, instrumental: true },
    });
    if (tracks.length === 0) return [];
    const terms = await client.trackTerm.findMany({
      where: { trackId: { in: tracks.map((t) => t.id) }, confirmed: true },
      select: { trackId: true, term: { select: { kind: true, slug: true } } },
    });
    const termsByTrack = new Map<string, Array<{ kind: "LANGUAGE" | "STYLE" | "DIRECTION"; slug: string }>>();
    for (const row of terms) {
      const list = termsByTrack.get(row.trackId) ?? [];
      list.push({ kind: row.term.kind, slug: row.term.slug });
      termsByTrack.set(row.trackId, list);
    }
    const expected = new Map(
      tracks.map((t) => [
        t.id,
        categoryKeysForTrack({
          language: t.language,
          instrumental: t.instrumental,
          terms: termsByTrack.get(t.id) ?? [],
        }),
      ]),
    );
    const actualRows = await client.trackScore.findMany({
      where: { trackId: { in: tracks.map((t) => t.id) } },
      select: { trackId: true, categoryKey: true },
    });
    const actual = new Map<string, Set<string>>();
    for (const row of actualRows) {
      const set = actual.get(row.trackId) ?? new Set<string>();
      set.add(row.categoryKey);
      actual.set(row.trackId, set);
    }
    const mismatched: string[] = [];
    for (const [trackId, keys] of expected) {
      const have = actual.get(trackId) ?? new Set<string>();
      if (keys.length !== have.size || keys.some((k) => !have.has(k))) {
        mismatched.push(trackId);
      }
    }
    return mismatched;
  }

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
    {
      // H-305: reconcile the chart categories after moderator term changes.
      name: "chart-category-reconcile",
      everyMs: 24 * 60 * 60 * 1000,
      run: async () => {
        const mismatched = await categoryMismatchedTrackIds();
        if (mismatched.length === 0) return "0 category mismatches";
        const written = await recomputeTrackScores(mismatched, Date.now(), { client });
        return `${written} tracks rescored (${mismatched.length} category mismatches)`;
      },
    },
    {
      // H-305: the weekly snapshot — a cheap existence check per tick; the
      // Monday 00:00 UTC snapshot is written by the first run of the week
      // (catch-up after downtime) and never rewritten afterwards.
      name: "charts-weekly-snapshot",
      everyMs: 10 * 60 * 1000,
      run: async () => ensureWeeklySnapshots(new Date(), { client }),
    },
  ];
}
