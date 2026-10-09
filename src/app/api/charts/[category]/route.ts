// GET /api/charts/[category] (H-305): the top 100 of one published
// category — rank, title, artist, public like count, restrictedIn. Only
// APPROVED, available, chart-eligible tracks (>= 10 voters, H-304); no
// dislike data anywhere in the payload. Unknown or unpublished categories
// answer 404 (S9 fail closed). Public read, cached at the edge for 60 s.

import { z } from "zod";
import { route } from "@/server/http/handler";
import { HttpError } from "@/server/http/errors";
import { parseCategoryKey } from "@/server/charts/categories";
import { chartTop } from "@/server/charts/service";

export const dynamic = "force-dynamic";

const categorySchema = z.object({ category: z.string().min(1).max(64) });

type Ctx = { params: Promise<{ category?: string }> };

export const GET = route<Ctx>(async (_req, ctx) => {
  const parsed = categorySchema.safeParse(await ctx.params);
  if (!parsed.success || parseCategoryKey(parsed.data.category) === null) {
    throw new HttpError(404, "CATEGORY_NOT_FOUND", "no such chart category");
  }
  const entries = await chartTop(parsed.data.category);
  return Response.json(
    { category: parsed.data.category, entries },
    { headers: { "cache-control": "public, s-maxage=60" } },
  );
});
