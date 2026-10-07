import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

// GET is wrapped by the shared pipeline (H-103) and returns a Promise.
describe("GET /api/health", () => {
  it("returns 200 with {status: ok} and a request id", async () => {
    const res = await GET(new Request("http://localhost:3000/api/health"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: "ok" });
  });
});
