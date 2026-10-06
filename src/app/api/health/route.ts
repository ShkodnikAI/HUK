export const dynamic = "force-dynamic";

// Public, read-only liveness probe (ARCHITECTURE §11). No business logic here:
// route handlers stay thin (AGENTS §7); services live in src/server/.
export function GET(): Response {
  return Response.json({ status: "ok" });
}
