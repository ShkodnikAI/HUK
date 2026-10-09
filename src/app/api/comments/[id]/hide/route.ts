// POST /api/comments/[id]/hide (H-303, S1): the track's artist hides a
// comment under their own track (status HIDDEN, audited). Moderators use
// POST /api/mod/comments/[id] instead.

import { z } from "zod";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { hideCommentAsArtist } from "@/server/comments/service";

export const dynamic = "force-dynamic";

const commentIdSchema = z.object({ id: z.string().min(1).max(64) });

type Ctx = { params: Promise<{ id?: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const { user } = await requireUser(req);
  const parsed = commentIdSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: id");
  }
  await hideCommentAsArtist(parsed.data.id, user.id);
  return Response.json({ comment: { id: parsed.data.id, status: "HIDDEN" } }, { status: 200 });
});
