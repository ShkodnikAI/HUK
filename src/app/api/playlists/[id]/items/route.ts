// POST /api/playlists/[id]/items (add, owner-only, eligibility + 500 cap)
// and PATCH /api/playlists/[id]/items (reorder; positions contiguous).

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { requireSession } from "@/server/guard";
import { addItem, reorderItems } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

export const addItemSchema = z.object({ trackId: z.string().min(1).max(64) });
export const reorderSchema = z.object({
  trackIds: z.array(z.string().min(1).max(64)).min(1).max(500),
});

type Ctx = { params: Promise<{ id?: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const playlistId = (await ctx.params).id ?? "";
  const body = await parseJson(req, addItemSchema);
  const { position } = await addItem(playlistId, user.id, body.trackId);
  return Response.json({ position }, { status: 201 });
});

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const playlistId = (await ctx.params).id ?? "";
  const body = await parseJson(req, reorderSchema);
  await reorderItems(playlistId, user.id, body.trackIds);
  return Response.json({ ok: true }, { status: 200 });
});
