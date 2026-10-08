// POST /api/listen/start (H-301): opens a server-verified listening
// session. Anonymous listeners are allowed — their identity is a client
// random id hashed with the daily-rotating salt (S7: never stored raw).
// RADIO mode requires the track to be the currently scheduled slot (the
// timeline is the source of truth, S2); PLAYLIST requires a public track.
// Rate limited per user and per IP hash.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { requireSession } from "@/server/guard";
import { HttpError } from "@/server/http/errors";
import { startListenSession } from "@/server/listen/session";

export const dynamic = "force-dynamic";

export const startSchema = z.object({
  trackId: z.string().min(1).max(64),
  mode: z.enum(["RADIO", "PLAYLIST"]),
  anonId: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/).optional(),
});

const START_LIMIT = { limit: 30, windowSec: 60 * 60 } as const;

export const POST = route(async (req) => {
  const env = loadEnv();

  // Identity: a signed-in session when present, otherwise the hashed anon id.
  let userId: string | null = null;
  try {
    const { user } = await requireSession(req);
    userId = user.id;
  } catch {
    userId = null; // anonymous listening is allowed by design (public route)
  }

  const ip = clientIp(req, env);
  const ipHash = ip ? hashIp(ip, new Date(), env) : null;
  if (!userId && !ipHash) {
    throw new HttpError(400, "NO_IDENTITY", "a session cookie or a client IP is required");
  }

  // Rate limit per user (signed-in) or per IP hash (anonymous).
  const verdict = await rateLimit({
    key: userId ? `listen-start:user:${userId}` : `listen-start:ip:${ipHash}`,
    ...START_LIMIT,
  });
  if (!verdict.ok) return tooManyRequests(verdict.retryAfterSec, "listen-start");

  const body = await parseJson(req, startSchema);
  const { sessionId } = await startListenSession(
    { trackId: body.trackId, mode: body.mode, anonId: body.anonId },
    { userId, anonHash: null },
  );
  return Response.json({ sessionId }, { status: 201 });
});
