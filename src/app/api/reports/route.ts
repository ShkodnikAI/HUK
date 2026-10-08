// POST /api/reports (H-206): the public report door. Signed-in users report
// with their account; anonymous reporters must leave a legal contact
// (reporterContact) — this is the contact form the policy requires.
// Rate limited per identity (session or IP hash); validated; deduplicated
// per reporter + target; triaged deterministically; stored as OPEN (S1:
// listed in scripts/ci/public-routes.txt by design).

import { z } from "zod";
import { parseJson } from "@/server/http/parse";
import { requireUser } from "@/server/guard";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { clientIp, hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";
import { createReport } from "@/server/reports/service";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  targetType: z.enum(["TRACK", "COMMENT", "PLAYLIST", "USER"]),
  targetId: z.string().min(1).max(64),
  reason: z
    .string()
    .transform((s) => s.normalize("NFC").trim())
    .refine((s) => s.length >= 1 && s.length <= 2000, "reason must be 1-2000 characters"),
  reporterContact: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= 3 && s.length <= 200, "reporterContact must be 3-200 characters")
    .optional(),
});

/** Stable rate-limit identity: session cookie token, then IP hash. */
async function reporterKey(req: Request): Promise<string> {
  const cookie = req.headers.get("cookie") ?? "";
  const token = cookie
    .split(";")
    .map((p) => p.trim().split("="))
    .find(([name]) => name === "next-auth.session-token" || name === "__Secure-next-auth.session-token")?.[1];
  if (token) return `reports:sess:${token.slice(0, 24)}`;
  const env = loadEnv();
  const ip = clientIp(req, env);
  if (ip) return `reports:ip:${hashIp(ip, new Date(), env)}`;
  return "reports:anon";
}

export const POST = route(
  async (req) => {
    const body = await parseJson(req, createSchema);

    // Signed-in reporting is preferred but anonymous contact reports are
    // legal-first-class: the guard failure must not become an error.
    let reporterId: string | null = null;
    try {
      reporterId = (await requireUser(req)).user.id;
    } catch {
      reporterId = null;
    }
    if (!reporterId && !body.reporterContact) {
      throw new HttpError(
        422,
        "REPORTER_CONTACT_REQUIRED",
        "anonymous reports need reporterContact (legal contact form)",
      );
    }

    const { reportId, deduped } = await createReport(body, reporterId);
    return Response.json({ reportId, deduped }, { status: deduped ? 200 : 201 });
  },
  { rateLimit: { key: reporterKey, limit: 10, windowSec: 3600 } },
);
