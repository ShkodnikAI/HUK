// POST /api/tracks/[id]/comments (H-303, S1): signed-in listeners comment
// after the H-301 gate (30 s verified listening on this track in 24 h) and
// the 24 h account-age gate; rate limited 5 per 10 min per user. Comments
// are untrusted text (S5) — normalised, link-free, 1-500 characters — and
// are HELD by default (Owner decision 2026-10-08 option (a)): nothing is
// published automatically while the text check is a stub.
// GET: public thread read (cursor pagination, newest first); only VISIBLE
// rows are public, the author additionally sees their own HELD rows with a
// "waiting for review" flag and their own moderated rows with the
// statement of reasons.

import { z } from "zod";
import { parseJson, parseQuery } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { assertCanComment, createComment, createCommentSchema, listComments } from "@/server/comments/service";

export const dynamic = "force-dynamic";

const COMMENT_POST_LIMIT = { limit: 5, windowSec: 10 * 60 } as const;

const trackIdSchema = z.object({ id: z.string().min(1).max(64) });

const listQuerySchema = z.object({
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type Ctx = { params: Promise<{ id?: string }> };

async function trackId(ctx: Ctx): Promise<string> {
  const parsed = trackIdSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: id");
  }
  return parsed.data.id;
}

export const POST = route<Ctx>(async (req, ctx) => {
  const { user } = await requireUser(req);
  const id = await trackId(ctx);
  const perUser = await rateLimit({ key: `comments:user:${user.id}`, ...COMMENT_POST_LIMIT });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "comments-user");
  const body = await parseJson(req, createCommentSchema);
  await assertCanComment(user, id);
  const { commentId, status } = await createComment(id, body, user);
  return Response.json({ comment: { id: commentId, status } }, { status: 201 });
});

export const GET = route<Ctx>(async (req, ctx) => {
  const id = await trackId(ctx);
  const query = parseQuery(new URL(req.url), listQuerySchema);
  // The viewer is optional: anonymous reads see only VISIBLE rows.
  let viewer: { id: string } | null = null;
  try {
    viewer = (await requireUser(req)).user;
  } catch {
    viewer = null;
  }
  const cursor = query.cursor ? new Date(query.cursor) : null;
  const { comments, nextCursor } = await listComments(id, viewer, cursor, query.limit);
  return Response.json({ comments, nextCursor });
});
