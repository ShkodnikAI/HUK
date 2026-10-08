// DELETE /api/playlists/[id]/items/[trackId] (H-302): removes the item
// (owner-only) and closes the position gap so positions stay contiguous.

import { route } from "@/server/http/handler";
import { requireSession } from "@/server/guard";
import { removeItem } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id?: string; trackId?: string }> };

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const params = await ctx.params;
  await removeItem(params.id ?? "", user.id, params.trackId ?? "");
  return Response.json({ ok: true }, { status: 200 });
});
