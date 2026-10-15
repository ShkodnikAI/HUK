// GET /api/tracks/mine (H-203, S2): the author sees their own tracks with
// the moderation status and, when present, the statement of reasons. No
// endpoint returns non-APPROVED tracks to anyone but the author.
// H-123: the owner's own lyrics ride along here for every status (the one
// sanctioned owner door), plus the server-reported limits — today's used
// submissions out of the author cap and the lyrics maximum — so the
// cabinet and the submit form never hard-code them.

import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { db } from "@/server/db";
import { loadEnv } from "@/server/env";
import { likeCounts } from "@/server/reactions/service";

export const dynamic = "force-dynamic";

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export const GET = route(async (req) => {
  const env = loadEnv();
  const { user } = await requireRole(req, "ARTIST");
  const tracks = await db.track.findMany({
    where: { artist: { is: { userId: user.id } } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, status: true, createdAt: true, licenseScope: true, lyrics: true },
    take: 100,
  });
  // H-301: the author's view carries the public LIKE count (never dislikes).
  const likes = await likeCounts(tracks.map((t) => t.id));
  // Statement of reasons: produced by takedown/moderation actions (H-206);
  // surfaced here when a resolved report targets one of the author's tracks.
  const reasons = await db.report.findMany({
    where: { targetType: "TRACK", targetId: { in: tracks.map((t) => t.id) }, resolution: { not: null } },
    select: { targetId: true, resolution: true },
  });
  const reasonByTrack = new Map(reasons.map((r) => [r.targetId, r.resolution as string]));
  // H-123: today's usage against the author cap (UTC day, same window the
  // quota enforcement in submitTrack counts) — the cabinet shows the line
  // the server reports, never a client-side guess.
  const usedToday = await db.track.count({
    where: { artist: { is: { userId: user.id } }, createdAt: { gte: utcMidnight(new Date()) } },
  });
  return Response.json({
    tracks: tracks.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      createdAt: t.createdAt,
      licenseScope: t.licenseScope,
      lyrics: t.lyrics,
      likes: likes.get(t.id) ?? 0,
      statementOfReasons: reasonByTrack.get(t.id) ?? null,
    })),
    limits: {
      dailySubmissionsUsed: usedToday,
      dailySubmissionsCap: env.AUTHOR_DAILY_SUBMISSION_CAP,
      lyricsMaxChars: env.LYRICS_MAX_CHARS,
    },
  });
});
