import { describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { HttpError, errorBody } from "@/server/http/errors";
import { parseJson, parseQuery } from "@/server/http/parse";
import { route } from "@/server/http/handler";
import { clientIp, hashIp } from "@/server/iphash";
import { sanitizePayload } from "@/server/audit";
import { loadEnv } from "@/server/env";

// H-103 contract tests: typed error mapping (400/413/422/429/500, no stack in
// bodies), input parsing limits, IP hashing rotation, audit sanitiser and the
// production env requirements.

afterEach(() => {
  vi.restoreAllMocks();
});

function post(url: string, init?: RequestInit): Request {
  return new Request(url, { method: "POST", ...init });
}

async function httpErrorOf(p: Promise<unknown>): Promise<HttpError> {
  try {
    await p;
  } catch (e) {
    return e as HttpError;
  }
  throw new Error("expected the promise to reject");
}

describe("parseJson (H-103)", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns the parsed value for valid input", async () => {
    const req = post("http://x/api", { body: JSON.stringify({ name: "a" }) });
    await expect(parseJson(req, schema)).resolves.toEqual({ name: "a" });
  });

  it("400 with INVALID_JSON for malformed JSON", async () => {
    const req = post("http://x/api", { body: "{nope" });
    const e = await httpErrorOf(parseJson(req, schema));
    expect(e.status).toBe(400);
    expect(e.code).toBe("INVALID_JSON");
  });

  it("413 over the byte limit (default 32 KB)", async () => {
    const big = JSON.stringify({ name: "x".repeat(33 * 1024) });
    const oversized = post("http://x/api", { body: big });
    await expect(parseJson(oversized, schema)).rejects.toMatchObject({
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
    });
    // A body under the default limit parses fine.
    const small = post("http://x/api", { body: JSON.stringify({ name: "a" }) });
    await expect(parseJson(small, schema)).resolves.toEqual({ name: "a" });
  });

  it("422 listing field paths only (no values) for zod failures", async () => {
    const req = post("http://x/api", { body: JSON.stringify({ name: "", secretValue: "TOPSECRET" }) });
    const err = await httpErrorOf(parseJson(req, schema));
    expect(err.status).toBe(422);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.message).toContain("name");
    expect(err.message).not.toContain("TOPSECRET");
  });

  it("parseQuery validates search params", () => {
    const schema = z.object({ limit: z.coerce.number().int().positive() });
    expect(parseQuery(new URL("http://x/api?limit=5"), schema)).toEqual({ limit: 5 });
    expect(() => parseQuery(new URL("http://x/api?limit=-2"), schema)).toThrow(HttpError);
  });
});

describe("route error mapping (H-103)", () => {
  it("maps HttpError to its status and keeps the shared body shape", async () => {
    const handler = route(() => {
      throw new HttpError(422, "VALIDATION_FAILED", "Invalid fields: name");
    });
    const res = await handler(post("http://x/api"), undefined);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string; requestId: string } };
    expect(body.error.code).toBe("VALIDATION_FAILED");
    expect(body.error.requestId).toBeTruthy();
    expect(res.headers.get("x-request-id")).toBe(body.error.requestId);
  });

  it("collapses unexpected errors to a generic 500 without stack or message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = route(() => {
      throw new Error("db password hunter2 leaked stack /user@host");
    });
    const res = await handler(post("http://x/api"), undefined);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("INTERNAL");
    expect(body.error.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("propagates success responses and stamps x-request-id", async () => {
    const handler = route(() => Response.json({ ok: true }));
    const res = await handler(post("http://x/api"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });
});

describe("hashIp (H-103, S7)", () => {
  const env = { IP_HASH_SALT: "test-only fixture value, not a credential", CLIENT_IP_HEADER: "cf-connecting-ip" } as Parameters<typeof hashIp>[2];

  it("is stable within one UTC day and changes the next day", () => {
    const d1 = new Date("2026-10-07T23:59:59Z");
    const d1again = new Date("2026-10-07T00:00:01Z");
    const d2 = new Date("2026-10-08T00:00:01Z");
    expect(hashIp("1.2.3.4", d1, env)).toBe(hashIp("1.2.3.4", d1again, env));
    expect(hashIp("1.2.3.4", d1, env)).not.toBe(hashIp("1.2.3.4", d2, env));
  });

  it("differs per IP and never contains the raw IP", () => {
    const now = new Date("2026-10-07T12:00:00Z");
    const a = hashIp("1.2.3.4", now, env);
    const b = hashIp("1.2.3.5", now, env);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/); // 32 hex chars = 16 bytes
    expect(a).not.toContain("1.2.3.4");
  });
});

describe("clientIp (H-103)", () => {
  const env = { CLIENT_IP_HEADER: "cf-connecting-ip" } as Parameters<typeof clientIp>[1];

  it("reads only the configured header and ignores x-forwarded-for", () => {
    const req = new Request("http://x/api", {
      headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "9.9.9.9" },
    });
    expect(clientIp(req, env)).toBe("203.0.113.7");
  });

  it("returns null when the header is absent", () => {
    expect(clientIp(new Request("http://x/api"), env)).toBeNull();
  });
});

describe("audit payload sanitiser (H-103)", () => {
  it("drops sensitive keys at any depth and truncates long strings", () => {
    const payload = {
      authorization: "Bearer topsecret",
      nested: { password: "pw", token: "t", keep: "ok", deeper: { COOKIE: "x", email: "a@b.c" } },
      note: "y".repeat(3000),
      count: 5,
    };
    const clean = sanitizePayload(payload) as Record<string, unknown>;
    expect(JSON.stringify(clean)).not.toMatch(/topsecret|"pw"|"t"|COOKIE|a@b\.c/);
    expect((clean.nested as Record<string, unknown>).keep).toBe("ok");
    expect(clean.count).toBe(5);
    const note = clean.note as string;
    expect(note.length).toBeLessThan(2100);
    expect(note).toContain("[truncated 3000 chars]");
  });
});

describe("production env requirements (H-103)", () => {
  const base = {
    DATABASE_URL: "postgresql://huk:huk@localhost:5432/huk",
    AUTH_SECRET: "test-only fixture value, not a credential",
  };

  it("refuses to start in production without IP_HASH_SALT / CLIENT_IP_HEADER", () => {
    expect(() =>
      loadEnv({ ...base, NODE_ENV: "production" }),
    ).toThrow(/required in production/);
  });

  it("starts in production when both are provided", () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: "production",
      IP_HASH_SALT: "test-only fixture value, not a credential",
      CLIENT_IP_HEADER: "cf-connecting-ip",
    });
    expect(env.IP_HASH_SALT).toBe("test-only fixture value, not a credential");
  });

  it("does not require them in development", () => {
    expect(() => loadEnv(base)).not.toThrow();
  });
});
