// PATCH /api/comments/[id] (H-303, S1): the commenter edits their own
// comment within 10 minutes; an edited comment returns to HELD — the
// hold-by-default policy applies to the new text as well (Owner decision
// 2026-10-08, option (a)).
// DELETE: the commenter removes their own comment — status REMOVED, body
// replaced by the placeholder (the DB check keeps length >= 1), audited.

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { deleteOwnComment, editCommentSchema, editOwnComment } from "@/server/comments/service";

export const dynamic = "force-dynamic";

const commentIdSchema = z.object({ id: z.string().min(1).max(64) });

type Ctx = { params: Promise<{ id?: string }> };

async function commentId(ctx: Ctx): Promise<string> {
  const parsed = commentIdSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: id");
  }
  return parsed.data.id;
}

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user } = await requireUser(req);
  const id = await commentId(ctx);
  const body = await parseJson(req, editCommentSchema);
  const { status } = await editOwnComment(id, body, user);
  return Response.json({ comment: { id, status } }, { status: 200 });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { user } = await requireUser(req);
  const id = await commentId(ctx);
  await deleteOwnComment(id, user);
  return Response.json({ comment: { id, status: "REMOVED" } }, { status: 200 });
});
