// GET /api/me/reactions (H-301): the CALLER's own reaction state for a
// list of tracks (?trackIds=a,b,c). Never anybody else's state; the
// response is private and uncacheable.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { requireSession } from "@/server/guard";
import { parseQuery } from "@/server/http/parse";
import { myReactions } from "@/server/reactions/service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  trackIds: z
    .string()
    .min(1)
    .max(64 * 100)
    .transform((s) => s.split(",").filter(Boolean).slice(0, 100)),
});

export const GET = route(async (req) => {
  const { user } = await requireSession(req);
  const { trackIds } = parseQuery(new URL(req.url), querySchema);
  const reactions = await myReactions(user.id, trackIds);
  return Response.json(
    { reactions }, // only the caller's own rows (own dislikes included)
    { status: 200, headers: { "cache-control": "private, no-store" } },
  );
});
