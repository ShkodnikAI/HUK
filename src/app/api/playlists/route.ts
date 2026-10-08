// GET/POST /api/playlists (H-302): the caller's own playlists, and
// playlist creation (50 per user, race-safe). Text goes through the
// central textCheck hook (H-209) plus local validators.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { requireSession } from "@/server/guard";
import { createPlaylist, listPlaylists } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

export const playlistCreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  visibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]).optional(),
});

export const GET = route(async (req) => {
  const { user } = await requireSession(req);
  const playlists = await listPlaylists(user.id);
  return Response.json({ playlists }, { status: 200 });
});

export const POST = route(async (req) => {
  const { user } = await requireSession(req);
  const body = await parseJson(req, playlistCreateSchema);
  const { id } = await createPlaylist(user.id, body);
  return Response.json({ id }, { status: 201 });
});
