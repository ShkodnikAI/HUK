// Reactions (H-301, ARCHITECTURE §9): signed-in listeners may LIKE or
// DISLIKE a track after at least 30 s of server-verified listening in the
// last 24 h. One reaction per user and track (upsert semantics — changing
// LIKE to DISLIKE updates the row); dislikes are never shown publicly (the
// public payloads carry LIKE counts only). S7: the writer's IP is stored
// only as the rotating salted hash.

import { db as defaultDb } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { VERIFIED_FOR_REACTION_MS } from "@/server/listen/session";

export type ReactionType = "LIKE" | "DISLIKE";

export type ReactSeam = {
  client?: typeof defaultDb;
  /** Injectable clock for the 24 h verification window. */
  now?: () => Date;
};

export type ReactionState = {
  trackId: string;
  type: ReactionType;
};

/**
 * Upserts the caller's reaction. Allowed only when a ListenSession for the
 * same track, owned by the user, reached VERIFIED_FOR_REACTION_MS within
 * the last 24 h.
 */
export async function react(
  input: { trackId: string; type: ReactionType },
  userId: string,
  ipHash: string | null,
  seam: ReactSeam = {},
): Promise<ReactionState> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const eligible = await client.listenSession.findFirst({
    where: {
      userId,
      trackId: input.trackId,
      verifiedMs: { gte: VERIFIED_FOR_REACTION_MS },
      startedAt: { gte: new Date(now().getTime() - 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (!eligible) {
    throw new HttpError(403, "LISTEN_NOT_VERIFIED", "30 s of verified listening required before reacting");
  }

  const track = await client.track.findUnique({ where: { id: input.trackId }, select: { id: true } });
  if (!track) throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${input.trackId}`);

  await client.reaction.upsert({
    where: { userId_trackId: { userId, trackId: input.trackId } },
    create: { userId, trackId: input.trackId, type: input.type, ipHash },
    update: { type: input.type, ipHash },
  });
  return { trackId: input.trackId, type: input.type };
}

/** Removes the caller's reaction (idempotent). */
export async function unreact(trackId: string, userId: string, seam: ReactSeam = {}): Promise<void> {
  const client = seam.client ?? defaultDb;
  await client.reaction.deleteMany({ where: { userId, trackId } });
}

/** LIKE counts per track (public payload field; dislikes are never counted). */
export async function likeCounts(trackIds: string[], seam: ReactSeam = {}): Promise<Map<string, number>> {
  const client = seam.client ?? defaultDb;
  if (trackIds.length === 0) return new Map();
  const rows = await client.reaction.groupBy({
    by: ["trackId"],
    where: { trackId: { in: trackIds }, type: "LIKE" },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.trackId, r._count._all]));
}

/** The caller's own reactions for the given tracks (nobody else's state). */
export async function myReactions(
  userId: string,
  trackIds: string[],
  seam: ReactSeam = {},
): Promise<ReactionState[]> {
  const client = seam.client ?? defaultDb;
  if (trackIds.length === 0) return [];
  const rows = await client.reaction.findMany({
    where: { userId, trackId: { in: trackIds } },
    select: { trackId: true, type: true },
    orderBy: { trackId: "asc" },
  });
  return rows;
}
