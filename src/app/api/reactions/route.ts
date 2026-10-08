// POST /api/reactions (H-301): LIKE/DISLIKE for signed-in listeners with
// 30 s of server-verified listening on the track (ARCHITECTURE §9). One
// reaction per user and track — a second call updates the row. Rate
// limited per user and per IP hash.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { parseJson } from "@/server/http/parse";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { requireSession } from "@/server/guard";
import { react } from "@/server/reactions/service";

export const dynamic = "force-dynamic";

export const reactionSchema = z.object({
  trackId: z.string().min(1).max(64),
  type: z.enum(["LIKE", "DISLIKE"]),
});

const REACT_LIMIT = { limit: 20, windowSec: 60 * 60 } as const;
const REACT_IP_LIMIT = { limit: 60, windowSec: 60 * 60 } as const;

export const POST = route(async (req) => {
  const env = loadEnv();
  const { user } = await requireSession(req);

  const ip = clientIp(req, env);
  const ipHash = ip ? hashIp(ip, new Date(), env) : null;

  const perUser = await rateLimit({ key: `react:user:${user.id}`, ...REACT_LIMIT });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "react-user");
  if (ipHash) {
    const perIp = await rateLimit({ key: `react:ip:${ipHash}`, ...REACT_IP_LIMIT });
    if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "react-ip");
  }

  const body = await parseJson(req, reactionSchema);
  const state = await react({ trackId: body.trackId, type: body.type }, user.id, ipHash);
  return Response.json(state, { status: 200 });
});
