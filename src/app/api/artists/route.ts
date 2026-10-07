// POST /api/artists (H-209): open-path artist profile creation. Only
// reachable when INVITE_ONLY=false; with the invite-only beta on, every
// caller is refused with 403 INVITE_REQUIRED (redemption is the path).

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { parseJson } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { loadEnv } from "@/server/env";
import { createProfileOpen } from "@/server/artists/service";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const env = loadEnv();
  const { user } = await requireUser(req);
  if (env.INVITE_ONLY) {
    throw new HttpError(403, "INVITE_REQUIRED", "Artist onboarding is invite-only right now");
  }
  const body = await parseJson(
    req,
    z.object({
      handle: z.string().min(1).max(40),
      displayName: z.string().min(1).max(80),
      bio: z.string().max(2000).optional(),
    }),
  );
  const profile = await createProfileOpen(user.id, body, env.INVITE_ONLY);
  return Response.json(
    { profile: { id: profile.id, handle: profile.handle, displayName: profile.displayName } },
    { status: 201 },
  );
});
