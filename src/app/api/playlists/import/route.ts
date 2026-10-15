// POST /api/playlists/import (H-302): a signed-in listener imports a
// guest playlist stored in the browser. At most 500 ids; ineligible or
// unknown ids are DROPPED and reported (no titles leaked for dropped ids).

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { requireSession } from "@/server/guard";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { importPlaylist, MAX_IMPORT_IDS, PLAYLIST_CREATE_LIMIT } from "@/server/playlists/service";

export const dynamic = "force-dynamic";

export const importSchema = z.object({
  name: z.string().min(1).max(100),
  trackIds: z.array(z.string().min(1).max(64)).min(1).max(MAX_IMPORT_IDS),
});

export const POST = route(async (req) => {
  const { user } = await requireSession(req);
  // H-307: an import CREATES a playlist — the create rate limit applies to
  // this path too (same-effect: the limit cannot be bypassed by importing).
  const limit = await rateLimit({ key: `pl:create:${user.id}`, ...PLAYLIST_CREATE_LIMIT });
  if (!limit.ok) return tooManyRequests(limit.retryAfterSec, "pl-create");
  const body = await parseJson(req, importSchema);
  const result = await importPlaylist(user.id, body);
  return Response.json(result, { status: 201 });
});
