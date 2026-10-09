// GET /api/charts (H-305): the category index — only published categories
// (at least 20 chart-eligible tracks). Public read outside /api/mod and
// /api/admin, identical for every caller, cached at the edge for 60 s.

import { route } from "@/server/http/handler";
import { chartIndex } from "@/server/charts/service";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const categories = await chartIndex();
  return Response.json(
    { categories },
    { headers: { "cache-control": "public, s-maxage=60" } },
  );
});
