// GET /api/mod/reports (H-206, S1): the moderator report queue — OPEN
// reports, most urgent first. MODERATOR/ADMIN only (ADMIN satisfies
// MODERATOR through requireRole). The reporter contact is visible here by
// necessity (the moderation queue is where the contact is used).

import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { listOpenReports } from "@/server/reports/service";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  await requireRole(req, "MODERATOR");
  const reports = await listOpenReports();
  return Response.json({ reports });
});
