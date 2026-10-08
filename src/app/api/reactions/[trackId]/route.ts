// DELETE /api/reactions/[trackId] (H-301): removes the caller's reaction
// for the track (idempotent — a missing reaction is still 200 OK).

import { z } from "zod";
import { route } from "@/server/http/handler";
import { requireSession } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { unreact } from "@/server/reactions/service";

export const dynamic = "force-dynamic";

const trackIdSchema = z.string().min(1).max(64);

type Ctx = { params: Promise<{ trackId?: string }> };

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const raw = (await ctx.params).trackId;
  const parsed = trackIdSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: trackId");
  }
  await unreact(parsed.data, user.id);
  return Response.json({ ok: true }, { status: 200 });
});
