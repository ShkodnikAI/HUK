// POST /api/playlists/import (H-302): a signed-in listener imports a
// guest playlist stored in the browser. At most 500 ids; ineligible or
// unknown ids are DROPPED and reported (no titles leaked for dropped ids).

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { requireSession } from "@/server/guard";
import { importPlaylist, MAX_IMPORT_IDS } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

export const importSchema = z.object({
  name: z.string().min(1).max(100),
  trackIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_IMPORT_IDS),
});

export const POST = route(async (req) => {
  const { user } = await requireSession(req);
  const body = await parseJson(req, importSchema);
  const result = await importPlaylist(user.id, body);
  return Response.json(result, { status: 201 });
});
