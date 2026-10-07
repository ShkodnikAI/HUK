import { route } from "@/server/http/handler";

export const dynamic = "force-dynamic";

// Public, read-only liveness probe (ARCHITECTURE §11). No business logic here:
// route handlers stay thin (AGENTS §7); services live in src/server/.
// Wrapped by the shared pipeline (H-103): request id + typed error mapping,
// still public and still without DB access.
export const GET = route((): Response => Response.json({ status: "ok" }));
