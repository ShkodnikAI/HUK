// Takedown (H-206, task 3): removes a track from the platform while keeping
// the evidence trail. Status TAKEN_DOWN (S2: /now and every public reader
// filter on APPROVED, so the track disappears from presentation at once),
// the live slot is ended and ALL future slots of the track are deleted in
// one transaction via retireTrackFromAir (H-212, G2), an AuditLog row
// records the actor and the reason.
// Idempotent: a second call on a TAKEN_DOWN track is a no-op.
//
// The statement of reasons itself lives on the resolved Report (S9: every
// removal records one) and reaches the author through GET /api/tracks/mine.

import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { retireTrackFromAir } from "@/server/broadcast/retire";

export type TakedownSeam = {
  client?: typeof defaultDb;
  now?: () => Date;
};

export type TakedownResult = {
  /** True when the track was already TAKEN_DOWN (the call changed nothing). */
  noop: boolean;
};

export async function takedownTrack(
  trackId: string,
  reason: string,
  actorId: string | null,
  seam: TakedownSeam = {},
): Promise<TakedownResult> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const track = await client.track.findUnique({ where: { id: trackId }, select: { id: true, status: true } });
  if (!track) {
    throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${trackId}`);
  }
  if (track.status === "TAKEN_DOWN") {
    return { noop: true }; // idempotent: the second call must change nothing
  }

  const at = now();
  await client.track.update({ where: { id: trackId }, data: { status: "TAKEN_DOWN" } });
  // The live slot ends and all future slots are deleted in ONE transaction
  // (H-212, G2); one scheduler tick fills the hole afterwards.
  await retireTrackFromAir(trackId, at, client);

  await audit({
    actorId: actorId ?? undefined,
    actorKind: actorId ? "user" : "worker",
    action: "track.taken-down",
    targetType: "Track",
    targetId: trackId,
    payload: { reason },
  });
  return { noop: false };
}
