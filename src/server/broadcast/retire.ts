// Retire a track from the air in ONE transaction (H-212, findings G2/G3).
// Every path that removes a track from the public timeline — takedown,
// source suspension (hash mismatch), source unavailability — ends the live
// slot and deletes ALL future slots of the track atomically, so a half-state
// (dead slot airing while future slots survive) is impossible. The
// scheduler self-heal (scheduler.ts) is the second line of defence for
// paths nobody remembers.

import type { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";

export type RetireResult = {
  /** The live slot that was ended, if one was airing at `at`. */
  ended: { seq: bigint; startsAt: Date; endsAt: Date } | null;
  /** How many future slots were deleted. */
  futureDeleted: number;
};

/**
 * Ends the live slot of `trackId` at `at` and deletes all its future slots
 * in a single transaction. `client` is injectable for tests; callers inside
 * an existing transaction should rely on the scheduler self-heal instead of
 * nesting (Prisma interactive transactions cannot nest).
 *
 * H-112 (D14/S3): the broadcast cache copy of the track is purged in the
 * SAME code path, so a takedown removes the bytes immediately (dynamic
 * import — audio-cache.ts imports this module; no cycle at init time).
 */
export async function retireTrackFromAir(
  trackId: string,
  at: Date,
  client: PrismaClient = defaultDb,
): Promise<RetireResult> {
  const result = await client.$transaction(async (tx) => {
    const live = await tx.broadcastSlot.findFirst({
      where: { trackId, startsAt: { lte: at }, endsAt: { gt: at } },
      orderBy: { seq: "asc" },
    });
    if (live) {
      await tx.broadcastSlot.update({ where: { seq: live.seq }, data: { endsAt: at } });
    }
    const future = await tx.broadcastSlot.deleteMany({
      where: { trackId, startsAt: { gt: at } },
    });
    return {
      ended: live ? { seq: live.seq, startsAt: live.startsAt, endsAt: live.endsAt } : null,
      futureDeleted: future.count,
    };
  });
  try {
    const { purgeTrackFromCache } = await import("./audio-cache");
    purgeTrackFromCache(trackId);
  } catch (e) {
    // The slots are retired; a failed purge must not fail the retirement —
    // the cache pass and the boot sweep evict the stray copy as backup.
    console.error(`[retire] cache purge failed for ${trackId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return result;
}
