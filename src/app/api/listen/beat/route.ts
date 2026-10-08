// POST /api/listen/beat (H-301): the listening heartbeat. Batched in the
// sense that beats may arrive in bursts — the credit math (5 s spacing,
// 15 s cap, lapse at 60 s) makes replaying or hammering worthless. The
// session must belong to the caller: the signed-in user, or (anonymous)
// the same rotating anon hash that opened it. `skipped: true` closes the
// session (the player sends it as the final beat, via sendBeacon).

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { requireSession } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { beat } from "@/server/listen/session";

export const dynamic = "force-dynamic";

export const beatSchema = z.object({
  sessionId: z.string().min(1).max(64),
  skipped: z.boolean().optional(),
  /** Anonymous callers present the same random id that opened the session. */
  anonId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const BEAT_LIMIT = { limit: 60, windowSec: 60 } as const;

export const POST = route(async (req) => {
  const env = loadEnv();

  let userId: string | null = null;
  try {
    const { user } = await requireSession(req);
    userId = user.id;
  } catch {
    userId = null; // anonymous sessions are allowed by design (public route)
  }

  const ip = clientIp(req, env);
  const ipHash = ip ? hashIp(ip, new Date(), env) : null;

  const verdict = await rateLimit({
    key: userId ? `listen-beat:user:${userId}` : `listen-beat:ip:${ipHash ?? "unknown"}`,
    ...BEAT_LIMIT,
  });
  if (!verdict.ok) return tooManyRequests(verdict.retryAfterSec, "listen-beat");

  const body = await parseJson(req, beatSchema);
  if (!userId && !body.anonId) {
    throw new HttpError(400, "NO_IDENTITY", "anonymous beats must carry the session's anonId");
  }
  const result = await beat(
    { sessionId: body.sessionId, skipped: body.skipped },
    { userId, anonHash: !userId && body.anonId ? hashIp(body.anonId, new Date(), env) : null },
  );
  return Response.json(result, { status: 200 });
});
