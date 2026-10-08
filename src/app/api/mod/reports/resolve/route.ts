// POST /api/mod/reports/resolve (H-206, S1/S9): a moderator resolves one
// report with a mandatory statement of reasons. Actions: DISMISS,
// TAKEDOWN (track), RESTRICT (track, per country), BAN (user — a human
// decision only, banDays mandatory, audited). Path uses a body field, not
// a URL param, so the authz matrix can call the handler directly.

import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { resolveReport, resolveSchema } from "@/server/reports/service";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { user } = await requireRole(req, "MODERATOR");
  const input = await parseJson(req, resolveSchema);
  const { status } = await resolveReport(input, user);
  return Response.json({ status }, { status: 200 });
});
