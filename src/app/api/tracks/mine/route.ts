// GET /api/tracks/mine (H-203, S2): the author sees their own tracks with
// the moderation status and, when present, the statement of reasons. No
// endpoint returns non-APPROVED tracks to anyone but the author.

import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { db } from "@/server/db";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const { user } = await requireRole(req, "ARTIST");
  const tracks = await db.track.findMany({
    where: { artist: { is: { userId: user.id } } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, licenseScope: true },
    take: 100,
  });
  // Statement of reasons: produced by takedown/moderation actions (H-206);
  // surfaced here when a resolved report targets one of the author's tracks.
  const reasons = await db.report.findMany({
    where: { targetType: "TRACK", targetId: { in: tracks.map((t) => t.id) }, resolution: { not: null } },
    select: { targetId: true, resolution: true },
  });
  const reasonByTrack = new Map(reasons.map((r) => [r.targetId, r.resolution as string]));
  return Response.json({
    tracks: tracks.map((t) => ({ ...t, statementOfReasons: reasonByTrack.get(t.id) ?? null })),
  });
});
