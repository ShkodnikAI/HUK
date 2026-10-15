// PATCH /api/tracks/[id]/lyrics (H-123, S1/S2): the ARTIST edits or removes
// the lyrics of their own track. The guard runs first (401/403), then the
// path id validates (422 with an empty param — the authz-matrix harness
// calls dynamic routes without params), then the per-user rate limit, then
// the body. Ownership, normalisation and the length-only audit row live in
// the shared service (src/server/tracks/lyrics.ts). Lyrics never appear in
// any response of a route the owner does not call — this route is the
// owner's own door.

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { loadEnv } from "@/server/env";
import { MAX_RAW_LYRICS_CHARS, updateLyrics } from "@/server/tracks/lyrics";

export const dynamic = "force-dynamic";

/** Modest edit rate: rewrites are rare; the cap blunts scripted abuse. */
const LYRICS_EDIT_LIMIT = { limit: 20, windowSec: 60 * 60 } as const;

const trackIdSchema = z.object({ id: z.string().min(1).max(64) });

const lyricsEditSchema = z.object({
  lyrics: z.string().max(MAX_RAW_LYRICS_CHARS).nullable(),
});

type Ctx = { params: Promise<{ id?: string }> };

async function trackId(ctx: Ctx): Promise<string> {
  const parsed = trackIdSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: id");
  }
  return parsed.data.id;
}

export const PATCH = route<Ctx>(async (req, ctx) => {
  const env = loadEnv();
  const { user } = await requireRole(req, "ARTIST");
  const id = await trackId(ctx);
  const perUser = await rateLimit({ key: `lyrics:user:${user.id}`, ...LYRICS_EDIT_LIMIT });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "lyrics-user");
  const body = await parseJson(req, lyricsEditSchema);
  const result = await updateLyrics(user.id, id, body.lyrics, env);
  return Response.json({ track: { id: result.trackId, lyrics: result.lyrics, lyricsLength: result.lyricsLength } });
});
