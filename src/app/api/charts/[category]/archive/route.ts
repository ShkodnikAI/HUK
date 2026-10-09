// GET /api/charts/[category]/archive?week=YYYY-MM-DD (H-305): the stored
// weekly snapshot — the list exactly as it was written, unchanged by later
// score recomputes. Unknown categories and malformed weeks answer 404.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { parseQuery } from "@/server/http/parse";
import { parseCategoryKey } from "@/server/charts/categories";
import { chartArchive, utcWeekStart } from "@/server/charts/service";

export const dynamic = "force-dynamic";

const categorySchema = z.object({ category: z.string().min(1).max(64) });
const archiveQuerySchema = z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "week must be YYYY-MM-DD") });

type Ctx = { params: Promise<{ category?: string }> };

export const GET = route<Ctx>(async (req, ctx) => {
  const parsed = categorySchema.safeParse(await ctx.params);
  if (!parsed.success || parseCategoryKey(parsed.data.category) === null) {
    throw new HttpError(404, "CATEGORY_NOT_FOUND", "no such chart category");
  }
  const query = parseQuery(new URL(req.url), archiveQuerySchema);
  const week = new Date(`${query.week}T00:00:00.000Z`);
  if (Number.isNaN(week.getTime()) || utcWeekStart(week).getTime() !== week.getTime()) {
    // Archives are keyed by the Monday of the week — anything else never
    // existed as a snapshot.
    throw new HttpError(404, "WEEK_NOT_FOUND", "no snapshot for that week");
  }
  const entries = await chartArchive(parsed.data.category, week);
  if (entries === null) {
    throw new HttpError(404, "WEEK_NOT_FOUND", "no snapshot for that week");
  }
  return Response.json(
    { category: parsed.data.category, week: query.week, entries },
    { headers: { "cache-control": "public, s-maxage=60" } },
  );
});
