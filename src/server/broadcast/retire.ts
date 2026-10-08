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
 */
export async function retireTrackFromAir(
  trackId: string,
  at: Date,
  client: PrismaClient = defaultDb,
): Promise<RetireResult> {
  return client.$transaction(async (tx) => {
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
}
