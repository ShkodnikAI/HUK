// POST /api/tracks (H-203): ARTIST-only submission. Declarations, consent
// and quotas are enforced in one transaction (see the service); the
// response echoes only the public fields (S2: internal fields never leak).

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { clientIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { submissionSchema, submitTrack } from "@/server/tracks/submit";

export const dynamic = "force-dynamic";

const SUBMIT_LIMIT = { limit: 10, windowSec: 60 * 60 } as const;

export const POST = route(async (req) => {
  const env = loadEnv();
  const { user } = await requireRole(req, "ARTIST");
  // The invite gate (H-203): with the invite-only beta on, only ARTIST role
  // (granted through redemption, H-209) may submit.
  if (env.INVITE_ONLY && user.role !== "ARTIST") {
    throw new HttpError(403, "INVITE_REQUIRED", "Artist onboarding is invite-only right now");
  }
  const perUser = await rateLimit({ key: `submit:user:${user.id}`, ...SUBMIT_LIMIT });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "submit-user");

  const body = await parseJson(req, submissionSchema);
  const ip = clientIp(req, env);
  const { trackId } = await submitTrack(user.id, ip, body, env);
  return Response.json({ track: { id: trackId, status: "PENDING" } }, { status: 201 });
});
