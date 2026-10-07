import { describe, expect, it } from "vitest";
import { SIGNIN_LIMITS, normalizeEmail } from "@/server/auth/options";
import { hashIp } from "@/server/iphash";
import { loadEnv } from "@/server/env";

// H-110 (F2) contract tests: normalizeEmail must be an exact replica of the
// Auth.js v4 default normalizer (node_modules/next-auth/core/routes/signin.js)
// so that the per-email limiter keys and the address actually mailed are
// derived by the same function.

const env = {
  IP_HASH_SALT: "test-only fixture value, not a credential",
} as Parameters<typeof hashIp>[2];
const now = new Date("2026-10-08T12:00:00Z");

/** The limiter key for an email exactly as signin-limit.ts derives it. */
function limiterKey(email: string): string {
  return `signin:email:${hashIp(normalizeEmail(email), now, env)}`;
}

describe("normalizeEmail replicates Auth.js (H-110 F2)", () => {
  it("maps the bypass table to one canonical address", () => {
    // The issue's table, with the comma variant in its realizable form: the
    // literal "a@b.com,x@evil.com" carries two @ and is rejected by the
    // Auth.js default itself (exactly one @) — see the throws-test below.
    // The actual bypass shape from the gate record is "a@b.com,x" (one @).
    const variants = [
      "A@B.com", // case folding
      "\uFF21\uFF20\uFF22.com", // full-width A @ B (NFKC folds to ASCII)
      "a@b.com,x", // domain cut at the first comma -> same mailbox
      "a@b.com", // already canonical
      "  a@b.com  ", // trim
    ];
    const canonical = variants.map((v) => normalizeEmail(v));
    for (const c of canonical) expect(c).toBe("a@b.com");
  });

  it("lowercases and keeps NFKC-folded input identical", () => {
    expect(normalizeEmail("MiXeD@ExAmPlE.CoM")).toBe("mixed@example.com");
    expect(normalizeEmail("\uFF4D\uFF45@example.com")).toBe("me@example.com");
  });

  it("rejects what Auth.js rejects", () => {
    for (const bad of [
      "no-at-sign",
      "a@b", // domain without a dot
      "a@@b.com", // two @
      'a"b@c.com', // quote character
      "@nodomain.com", // empty local part... (local empty -> throw)
      "a@b.com,x@c.com", // two @ after the comma makes two @ in total
    ]) {
      expect(() => normalizeEmail(bad)).toThrowError(/Invalid email address format/);
    }
  });

  it("is idempotent on valid input", () => {
    for (const email of ["A@B.com", "a@b.com,x", "\uFF21\uFF20\uFF22.com"]) {
      const once = normalizeEmail(email);
      expect(normalizeEmail(once)).toBe(once);
    }
  });

  it("all variants map to ONE limiter key", () => {
    const keys = ["A@B.com", "\uFF21\uFF20\uFF22.com", "a@b.com,x", "a@b.com"].map(limiterKey);
    expect(new Set(keys).size).toBe(1);
  });

  it("limiter numbers stay centralized (H-102)", () => {
    expect(SIGNIN_LIMITS.perEmail.limit).toBe(5);
    expect(SIGNIN_LIMITS.perIp.limit).toBe(20);
  });
});
