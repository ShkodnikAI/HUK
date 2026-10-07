// GET /api/radio/now (H-104, ADR-0004): a PURE read — identical for all
// listeners, no writes, at most 2 DB queries, cached 2 s at the edge.
// The shape is the shared contract in src/lib/radio/contract.ts.

import type { PrismaClient } from "@prisma/client";
import { db } from "@/server/db";
import { route } from "@/server/http/handler";
import type { RadioNowResponse, RadioNowSlot, RadioNowTrack } from "@/lib/radio/contract";

export const dynamic = "force-dynamic";

/** How many upcoming slots /now exposes. */
export const NEXT_LIMIT = 5;

type SlotRow = {
  seq: bigint;
  trackId: string;
  startsAt: Date;
  endsAt: Date;
  title: string;
  durationSec: number;
  artist: string | null;
  audioUrl: string | null;
};

/**
 * Reads the timeline: the slot covering `nowMs` (if any) plus the next ones.
 * One query; the injectable client keeps the query count testable.
 */
export async function radioNow(
  nowMs: number,
  client: Pick<PrismaClient, "$queryRaw"> = db,
): Promise<RadioNowResponse> {
  const now = new Date(nowMs);
  const rows = await client.$queryRaw<SlotRow[]>`
    SELECT s."seq", s."trackId", s."startsAt", s."endsAt",
           t."title", t."durationSec",
           a."displayName" AS "artist",
           ts."url"        AS "audioUrl"
      FROM "BroadcastSlot" s
      JOIN "Track" t        ON t."id" = s."trackId"
      LEFT JOIN "ArtistProfile" a ON a."id" = t."artistId"
      LEFT JOIN "TrackSource" ts  ON ts."trackId" = t."id"
     WHERE s."endsAt" > ${now}
       AND t."status" = 'APPROVED'   -- F3 (H-110, S2): never serve slots
       AND t."available" = true      -- whose track is not public right now
     ORDER BY s."startsAt" ASC
     LIMIT ${NEXT_LIMIT + 2}
  `;

  const toTrack = (row: SlotRow): RadioNowTrack => ({
    id: row.trackId,
    title: row.title,
    artist: row.artist,
    durationSec: row.durationSec,
    audioUrl: row.audioUrl ?? "",
  });

  const first = rows[0];
  const current =
    first && first.startsAt.getTime() <= nowMs
      ? {
          track: toTrack(first),
          startsAt: first.startsAt.getTime(),
          endsAt: first.endsAt.getTime(),
          offsetMs: nowMs - first.startsAt.getTime(),
        }
      : null;

  const next: RadioNowSlot[] = rows
    .filter((row) => row.startsAt.getTime() > nowMs)
    .slice(0, NEXT_LIMIT)
    .map((row) => ({
      track: toTrack(row),
      startsAt: row.startsAt.getTime(),
      endsAt: row.endsAt.getTime(),
    }));

  return { serverTime: nowMs, current, next };
}

export const GET = route(async () => {
  const body = await radioNow(Date.now());
  return Response.json(body, {
    headers: { "cache-control": "public, s-maxage=2, stale-while-revalidate=5" },
  });
});
