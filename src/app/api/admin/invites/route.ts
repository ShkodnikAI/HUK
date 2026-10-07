// POST /api/admin/invites (H-209, S1): ADMIN creates one or more artist
// invites. The plain codes are returned exactly once in this response and
// are never stored (only their SHA-256) nor logged.

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireRole } from "@/server/guard";
import { route } from "@/server/http/handler";
import { createInvites } from "@/server/artists/service";

export const dynamic = "force-dynamic";

export const POST = route(async (req) => {
  const { user } = await requireRole(req, "ADMIN");
  const body = await parseJson(
    req,
    z.object({
      count: z.number().int().min(1).max(20).default(1),
      expiresInDays: z.number().int().min(1).max(365).default(14),
      note: z.string().max(200).optional(),
    }),
  );
  const invites = await createInvites(user.id, body.count, body.expiresInDays, body.note);
  return Response.json({ invites }, { status: 201 });
});
