// GET /api/geo (H-206): the listener's country, read from the single
// trusted edge header. UNCACHEABLE by design (per-listener answer); the
// public /api/radio/now stays identical for everyone and cache-safe — the
// player combines the two client-side. No country in the answer when the
// header is absent: the player then never skips anything (fail open for
// presentation only; nothing security-relevant depends on this endpoint).

import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const raw = req.headers.get("cf-ipcountry")?.trim() ?? "";
  const country = /^[A-Za-z]{2}$/.test(raw) ? raw.toUpperCase() : null;
  return Response.json(
    { country },
    { headers: { "cache-control": "private, no-store" } },
  );
});
