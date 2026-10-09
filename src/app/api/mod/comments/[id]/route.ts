// POST /api/mod/comments/[id] (H-303, S1): moderator decisions on the
// comment queue — approve (HELD → VISIBLE), hide (→ HIDDEN) and remove
// (→ REMOVED) with a mandatory statement of reasons. MODERATOR/ADMIN only
// (requireRole); every decision is audited with the actor and the reason,
// and the reason reaches the commenter through their own-comments view.

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { moderatorCommentAction, moderatorCommentActionSchema } from "@/server/comments/service";

export const dynamic = "force-dynamic";

const commentIdSchema = z.object({ id: z.string().min(1).max(64) });

type Ctx = { params: Promise<{ id?: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const { user } = await requireRole(req, "MODERATOR");
  const parsed = commentIdSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: id");
  }
  const input = await parseJson(req, moderatorCommentActionSchema);
  const { status } = await moderatorCommentAction(parsed.data.id, input, user);
  return Response.json({ comment: { id: parsed.data.id, status } }, { status: 200 });
});
