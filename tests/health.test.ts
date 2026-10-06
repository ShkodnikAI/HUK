import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("returns 200 with {status: ok}", () => {
    const res = GET();
    expect(res.status).toBe(200);
    return res.json().then((body) => expect(body).toEqual({ status: "ok" }));
  });
});
