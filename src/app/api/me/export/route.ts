// GET /api/me/export (H-214, S7): one JSON document with the caller's own
// data — profile, artist profile, own tracks (metadata and declarations,
// no audio), consents, playlists with items, reactions, comments, the raw
// listen events still inside retention, and the reports they filed. Never
// another user's data. Signed-in only, rate limited to 3 per day.

import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { EXPORT_RATE_LIMIT, exportUserData } from "@/server/account/service";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const { user } = await requireUser(req);
  const perUser = await rateLimit({ key: `export:user:${user.id}`, ...EXPORT_RATE_LIMIT });
  if (!perUser.ok) return tooManyRequests(perUser.retryAfterSec, "export-user");
  const document = await exportUserData(user);
  return Response.json(document, {
    headers: { "content-disposition": 'attachment; filename="huk-account-export.json"' },
  });
});
