// H-306: unit tests for the connection-string mechanism in src/server/db-url.ts.

import { describe, expect, it } from "vitest";
import { withUtcTimeZone } from "@/server/db-url";

/** Reads the decoded `options` parameter back from a produced URL. */
function optionsOf(url: string): string {
  return new URL(url).searchParams.get("options") ?? "";
}

describe("withUtcTimeZone (H-306)", () => {
  it("adds options=-c timezone=UTC to a URL without query parameters", () => {
    const out = withUtcTimeZone("postgresql://huk:huk@db.local:5432/huk");
    expect(optionsOf(out)).toBe("-c timezone=UTC");
    expect(out).toContain("postgresql://huk:huk@db.local:5432/huk");
  });

  it("preserves other query parameters and credentials", () => {
    const out = withUtcTimeZone(
      "postgresql://huk:secret@db.local:5432/huk?sslmode=require&connection_limit=10",
    );
    const parsed = new URL(out);
    expect(parsed.searchParams.get("sslmode")).toBe("require");
    expect(parsed.searchParams.get("connection_limit")).toBe("10");
    expect(parsed.username).toBe("huk");
    expect(parsed.password).toBe("secret");
    expect(optionsOf(out)).toBe("-c timezone=UTC");
  });

  it("replaces a timezone the URL already pinned and keeps unrelated -c pairs", () => {
    const out = withUtcTimeZone(
      "postgresql://huk@db.local:5432/huk?options=-c%20statement_timeout%3D5000%20-c%20timezone%3DEurope%2FMinsk",
    );
    const options = optionsOf(out);
    expect(options).toContain("statement_timeout=5000");
    expect(options).toContain("timezone=UTC");
    expect(options).not.toContain("Europe/Minsk");
  });

  it("encodes the space as %20 (RFC 3986), never the form-style +", () => {
    const out = withUtcTimeZone("postgresql://huk@db.local:5432/huk");
    expect(out).toContain("options=-c%20timezone%3DUTC");
    expect(out).not.toContain("+");
  });

  it("accepts the postgres:// scheme and passwordless credentials", () => {
    const out = withUtcTimeZone("postgres://huk@db.local:5432/huk");
    expect(optionsOf(out)).toBe("-c timezone=UTC");
    expect(new URL(out).username).toBe("huk");
  });

  it("hands a non-URL string through unchanged (S8 rejects it earlier)", () => {
    expect(withUtcTimeZone("not-a-url")).toBe("not-a-url");
  });
});
