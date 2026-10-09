// Charts service (H-305, ARCHITECTURE §9): the public top-100 per
// category, the published-category index and the weekly snapshots.
//
// Eligibility: only APPROVED, available tracks with at least MIN_VOTERS
// distinct voters (H-304). Dislikes shape the score but are never shown —
// no public payload carries dislike data (S2, card done criteria).
// Categories under PUBLISHED_MIN_TRACKS eligible tracks are not listed
// (their tracks remain in `all`).
//
// Snapshots: one ChartSnapshot per (weekStart, categoryKey), written by a
// leader-gated job for the current UTC week (Monday 00:00). The unique key
// makes re-running idempotent; a stored snapshot is never rewritten, so
// the archive stays unchanged after scores move (done criteria).

import { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";
import { MIN_VOTERS } from "@/server/ranking/signals";
import { parseCategoryKey, publishedCategories } from "./categories";

export const CHART_LIMIT = 100;

export type ChartEntryView = {
  rank: number;
  trackId: string;
  title: string;
  artist: string | null;
  likes: number;
  restrictedIn: string[];
};

/** The Monday 00:00 UTC that contains `at`. */
export function utcWeekStart(at: Date): Date {
  const day = at.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const offset = (day + 6) % 7; // days since Monday
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - offset));
}

/**
 * The top of one category. Read-only, no guard (public GET outside
 * /api/mod and /api/admin), identical for every caller.
 */
export async function chartTop(
  categoryKey: string,
  seam: { client?: PrismaClient } = {},
): Promise<ChartEntryView[]> {
  const client = seam.client ?? defaultDb;
  if (parseCategoryKey(categoryKey) === null) {
    return []; // unknown category: the route answers 404 before this
  }
  const rows = await client.trackScore.findMany({
    where: {
      categoryKey,
      voters: { gte: MIN_VOTERS },
      track: { status: "APPROVED", available: true },
    },
    orderBy: [{ score: "desc" }, { trackId: "asc" }],
    take: CHART_LIMIT,
    select: {
      trackId: true,
      track: {
        select: { title: true, artist: { select: { displayName: true } }, restrictions: { select: { countryCode: true } } },
      },
    },
  });
  if (rows.length === 0) return [];

  const likeRows = await client.reaction.groupBy({
    by: ["trackId"],
    where: { trackId: { in: rows.map((r) => r.trackId) }, type: "LIKE" },
    _count: { _all: true },
  });
  const likes = new Map(likeRows.map((r) => [r.trackId, r._count._all]));

  return rows.map((row, index) => ({
    rank: index + 1,
    trackId: row.trackId,
    title: row.track.title,
    artist: row.track.artist?.displayName ?? null,
    likes: likes.get(row.trackId) ?? 0,
    restrictedIn: row.track.restrictions.map((r) => r.countryCode),
  }));
}

export type ChartIndexEntry = { key: string; tracks: number };

/** The category index: published categories only. */
export async function chartIndex(
  seam: { client?: PrismaClient } = {},
): Promise<ChartIndexEntry[]> {
  return publishedCategories(seam);
}

export type ArchiveEntryView = { rank: number; trackId: string; title: string; artist: string | null; score: number };

/** The stored snapshot list — unchanged by later score recomputes. */
export async function chartArchive(
  categoryKey: string,
  weekStart: Date,
  seam: { client?: PrismaClient } = {},
): Promise<ArchiveEntryView[] | null> {
  const client = seam.client ?? defaultDb;
  if (parseCategoryKey(categoryKey) === null) return null;
  const snapshot = await client.chartSnapshot.findUnique({
    where: { weekStart_categoryKey: { weekStart, categoryKey } },
    include: {
      entries: {
        orderBy: { rank: "asc" },
        include: { track: { select: { title: true, artist: { select: { displayName: true } } } } },
      },
    },
  });
  if (!snapshot) return null;
  return snapshot.entries.map((entry) => ({
    rank: entry.rank,
    trackId: entry.trackId,
    title: entry.track.title,
    artist: entry.track.artist?.displayName ?? null,
    score: entry.score,
  }));
}

/**
 * Weekly snapshot pass (leader-gated via the maintenance runner): for the
 * current UTC week, write the missing snapshots for every published
 * category. Idempotent through the unique (weekStart, categoryKey) key;
 * existing snapshots are never rewritten. Catches up after downtime over
 * Monday by writing on the first run of the week (the state at that
 * moment — scores are not historical).
 */
export async function ensureWeeklySnapshots(
  now: Date,
  seam: { client?: PrismaClient } = {},
): Promise<string> {
  const client = seam.client ?? defaultDb;
  const weekStart = utcWeekStart(now);
  const published = await publishedCategories({ client });
  if (published.length === 0) return `no published categories for week ${weekStart.toISOString().slice(0, 10)}`;

  const existing = await client.chartSnapshot.findMany({
    where: { weekStart, categoryKey: { in: published.map((p) => p.key) } },
    select: { categoryKey: true },
  });
  const have = new Set(existing.map((row) => row.categoryKey));
  let written = 0;
  for (const category of published) {
    if (have.has(category.key)) continue;
    const top = await chartTop(category.key, { client });
    if (top.length === 0) continue; // nothing eligible this week
    const scoreRows = await client.trackScore.findMany({
      where: { trackId: { in: top.map((t) => t.trackId) }, categoryKey: category.key },
      select: { trackId: true, score: true },
    });
    const scoreOf = new Map(scoreRows.map((r) => [r.trackId, r.score]));
    const snapshot = await client.chartSnapshot.create({
      data: { weekStart, categoryKey: category.key },
      select: { id: true },
    });
    await client.chartEntry.createMany({
      data: top.map((entry) => ({
        snapshotId: snapshot.id,
        rank: entry.rank,
        trackId: entry.trackId,
        score: scoreOf.get(entry.trackId) ?? 0,
      })),
    });
    written++;
  }
  return `week ${weekStart.toISOString().slice(0, 10)}: ${written} snapshot(s) written, ${published.length} published categories`;
}
