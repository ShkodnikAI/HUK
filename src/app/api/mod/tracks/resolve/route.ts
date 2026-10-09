// POST /api/mod/tracks/resolve (H-207, S1): moderator decisions on the
// moderation queue — approve, reject (with a mandatory statement of
// reasons), restrict by country; H-402 adds SET_TERMS (replace the track's
// confirmed taxonomy terms from the controlled vocabulary, any status).
// MODERATOR/ADMIN only (requireRole), every decision audited with the
// actor (see src/server/tracks/moderator-actions.ts).

import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { moderatorActionSchema, moderatorTrackAction } from "@/server/tracks/moderator-actions";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { user } = await requireRole(req, "MODERATOR");
  const input = await parseJson(req, moderatorActionSchema);
  const { status } = await moderatorTrackAction(input, user);
  return Response.json({ status }, { status: 200 });
});
