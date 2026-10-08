// GET/PATCH/DELETE /api/playlists/[id] (H-302). GET is public for PUBLIC
// and UNLISTED playlists and owner-only for PRIVATE (a 404 that does not
// reveal existence for anyone else). PATCH/DELETE are owner-only.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { requireSession } from "@/server/guard";
import { deletePlaylist, getPlaylist, updatePlaylist } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

export const playlistPatchSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
});

type Ctx = { params: Promise<{ id?: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const playlistId = (await ctx.params).id ?? "";
  // Identity is optional: PUBLIC/UNLISTED are readable signed out.
  let viewerId: string | null = null;
  try {
    const { user } = await requireSession(req);
    viewerId = user.id;
  } catch {
    viewerId = null;
  }
  const playlist = await getPlaylist(playlistId, viewerId);
  return Response.json(playlist, { status: 200 });
});

export const PATCH = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const playlistId = (await ctx.params).id ?? "";
  const body = await parseJson(req, playlistPatchSchema);
  await updatePlaylist(playlistId, user.id, body);
  return Response.json({ ok: true }, { status: 200 });
});

export const DELETE = route<Ctx>(async (req, ctx) => {
  const { user } = await requireSession(req);
  const playlistId = (await ctx.params).id ?? "";
  await deletePlaylist(playlistId, user.id);
  return Response.json({ ok: true }, { status: 200 });
});
