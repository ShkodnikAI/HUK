import { describe, expect, it } from "vitest";
import { loadEnv } from "@/server/env";

const base = {
  DATABASE_URL: "postgresql://huk:huk@localhost:5432/huk",
  AUTH_SECRET: "test-only fixture value, not a credential",
};

describe("loadEnv (S8)", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.NEXTAUTH_URL).toBe("http://localhost:3000");
    expect(env.INVITE_ONLY).toBe(true);
    expect(env.BUDGET_DAILY_MICRO_USD_TOTAL).toBe(1_000_000);
    expect(env.PLATFORM_DAILY_SUBMISSION_CAP).toBe(10);
  });

  it("fails loudly when DATABASE_URL is missing", () => {
    expect(() =>
      loadEnv({ AUTH_SECRET: base.AUTH_SECRET }),
    ).toThrowError(/Invalid environment \(S8\)/);
  });

  it("fails loudly on a short AUTH_SECRET", () => {
    expect(() => loadEnv({ ...base, AUTH_SECRET: "short" })).toThrowError(
      /at least 32 chars/,
    );
  });

  it("rejects a non-numeric cap instead of silently defaulting (S9)", () => {
    expect(() =>
      loadEnv({ ...base, PLATFORM_DAILY_SUBMISSION_CAP: "ten" }),
    ).toThrowError(/Invalid environment \(S8\)/);
  });

  it("parses INVITE_ONLY=false as boolean false", () => {
    const env = loadEnv({ ...base, INVITE_ONLY: "false" });
    expect(env.INVITE_ONLY).toBe(false);
  });

  it("refuses to start in production with a non-https NEXTAUTH_URL (H-110 F1)", () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: "production",
        IP_HASH_SALT: "test-only fixture value, not a credential",
        CLIENT_IP_HEADER: "cf-connecting-ip",
        EMAIL_SERVER: "smtp://user:pass@localhost:1025",
        AUDIO_CACHE_DIR: "/var/lib/huk/audio-cache",
        NEXTAUTH_URL: "http://insecure.example",
      }),
    ).toThrow(/NEXTAUTH_URL/);
  });

  it("accepts an https NEXTAUTH_URL in production (H-110 F1)", () => {
    const env = loadEnv({
      ...base,
      NODE_ENV: "production",
      IP_HASH_SALT: "test-only fixture value, not a credential",
      CLIENT_IP_HEADER: "cf-connecting-ip",
      EMAIL_SERVER: "smtp://user:pass@localhost:1025",
      AUDIO_CACHE_DIR: "/var/lib/huk/audio-cache",
      NEXTAUTH_URL: "https://radio.example",
    });
    expect(env.NEXTAUTH_URL).toBe("https://radio.example");
  });
});
