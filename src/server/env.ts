import { z } from "zod";

// S8 — the environment is validated once, at boot. Nothing anywhere else in the
// codebase reads process.env directly (CI: scripts/ci/check-no-process-env.mjs,
// wired into the `invariants` job; single documented exception H-107-EXCEPTION
// in src/instrumentation.ts; see also docs/AUDIT.md §3 grep 3).
// Mirrors .env.example; defaults match the example values.

const schema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 chars (generate: openssl rand -base64 32)"),
  AUTH_URL: z.url().default("http://localhost:3000"),
  // Optional at scaffold stage; required by H-103 when IP hashing lands.
  IP_HASH_SALT: z.string().min(16).optional(),
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().default("HUK <no-reply@example.com>"),
  AUDIUS_API_KEY: z.string().optional(),
  ACOUSTID_API_KEY: z.string().optional(),
  AUDD_API_TOKEN: z.string().optional(),
  ASR_API_KEY: z.string().optional(),
  LLM_API_KEY: z.string().optional(),
  BUDGET_DAILY_MICRO_USD_TOTAL: z.coerce
    .number()
    .int()
    .positive()
    .default(1_000_000),
  PLATFORM_DAILY_SUBMISSION_CAP: z.coerce.number().int().positive().default(10),
  AUTHOR_DAILY_SUBMISSION_CAP: z.coerce.number().int().positive().default(2),
  INVITE_ONLY: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(true),
  RETENTION_LISTEN_EVENTS_DAYS: z.coerce.number().int().positive().default(90),
  RETENTION_TRANSCRIPTS_DAYS: z.coerce.number().int().positive().default(90),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    // Fail loud (S9): a typed error at boot, never a silent partial config.
    throw new Error(`Invalid environment (S8), refusing to start:\n${issues}`);
  }
  return parsed.data;
}
