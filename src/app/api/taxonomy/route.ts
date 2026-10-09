// GET /api/taxonomy (H-402): the public read of the controlled vocabulary
// with the number of APPROVED, available tracks per term. Read-only, no
// guard (public GET outside /api/mod and /api/admin), identical for every
// caller, cached at the edge for 5 minutes. Labels come from the
// vocabulary files (English); localized labels are looked up by the client
// through the message catalogs (`taxonomy.<kind>.<slug>`). Counts only
// confirmed terms — unconfirmed (AI-suggested) rows never exist yet and
// would not be a public attribution.

import { db } from "@/server/db";
import { route } from "@/server/http/handler";
import { DIRECTIONS, LANGUAGES, STYLES } from "@/server/taxonomy/vocabulary";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const counts = await db.trackTerm.groupBy({
    by: ["termId"],
    where: { confirmed: true, track: { status: "APPROVED", available: true } },
    _count: { trackId: true },
  });
  const byTermId = new Map(counts.map((c) => [c.termId, c._count.trackId]));

  const terms = await db.taxonomyTerm.findMany({
    select: { id: true, kind: true, slug: true },
  });
  const idOf = new Map(terms.map((t) => [`${t.kind}:${t.slug}`, t.id]));
  const countOf = (kind: string, slug: string): number => {
    const id = idOf.get(`${kind}:${slug}`);
    return id ? (byTermId.get(id) ?? 0) : 0;
  };

  return Response.json(
    {
      language: Object.entries(LANGUAGES).map(([slug, label]) => ({
        slug,
        label,
        tracks: countOf("LANGUAGE", slug),
      })),
      direction: Object.entries(DIRECTIONS).map(([slug, label]) => ({
        slug,
        label,
        tracks: countOf("DIRECTION", slug),
      })),
      style: Object.entries(STYLES).map(([slug, def]) => ({
        slug,
        label: def.label,
        parent: def.parent,
        tracks: countOf("STYLE", slug),
      })),
    },
    { headers: { "cache-control": "public, s-maxage=300" } },
  );
});
