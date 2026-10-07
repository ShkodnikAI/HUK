// POST /api/invites/redeem (H-209): any signed-in user redeems a valid,
// unused, unexpired invite code for an artist profile plus the ARTIST role
// in one transaction. Rate-limited per user AND per IP hash. Reused,
// expired and malformed codes all answer with the same generic 404 — no
// oracle for which one it was (S9).

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { tooManyRequests, rateLimit } from "@/server/ratelimit";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { redeemInvite } from "@/server/artists/service";

export const dynamic = "force-dynamic";

/** H-209: per-user and per-IP-hash buckets for redemption attempts. */
const REDEEM_LIMITS = {
  perUser: { limit: 5, windowSec: 60 * 60 },
  perIp: { limit: 10, windowSec: 60 * 60 },
} as const;

export const POST = route(async (req) => {
  const env = loadEnv();
  const { user } = await requireUser(req);
  const now = new Date();

  // Per-user bucket.
  const perUser = await rateLimit({ key: `redeem:user:${user.id}`, ...REDEEM_LIMITS.perUser });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "redeem-user");
  // Per-IP-hash bucket (the IP never persists; see H-504 in LIMITATIONS).
  const ip = clientIp(req, env);
  if (ip) {
    const perIp = await rateLimit({ key: `redeem:ip:${hashIp(ip, now, env)}`, ...REDEEM_LIMITS.perIp });
    if (!perIp.ok) return tooManyRequests(perIp.retryAfterSec, "redeem-ip");
  }

  const body = await parseJson(
    req,
    z.object({
      code: z.string().min(1).max(200),
      handle: z.string().min(1).max(40),
      displayName: z.string().min(1).max(80),
    }),
  );
  const profile = await redeemInvite(user.id, body);
  return Response.json(
    { profile: { id: profile.id, handle: profile.handle, displayName: profile.displayName } },
    { status: 201 },
  );
});
