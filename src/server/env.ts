// S8 — the environment is validated once, at boot. Nothing anywhere else in the
// codebase reads process.env directly (CI: scripts/ci/check-no-process-env.mjs,
// wired into the `invariants` job; single documented exception H-107-EXCEPTION
// in src/instrumentation.ts; see also docs/AUDIT.md §3 grep 3).
// Mirrors .env.example; defaults match the example values.

import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 chars (generate: openssl rand -base64 32)"),
  // Base URL for Auth.js magic links (H-110, F1): next-auth v4 reads it ONLY
  // from NEXTAUTH_URL (node_modules/next-auth/utils/detect-origin.js). Keep
  // AUTH_TRUST_HOST unset — deriving the origin from forwarded headers would
  // allow link poisoning.
  NEXTAUTH_URL: z.url().default("http://localhost:3000"),
  // Next.js sets NODE_ENV itself; validated so production requirements below
  // can key off it (H-103).
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  // Optional at scaffold stage; required by H-103 in production (S8, fail
  // loud). In development a fixed default is applied by src/server/iphash.ts.
  IP_HASH_SALT: z.string().min(16).optional(),
  // The only client-IP header the platform trusts (H-103). Never
  // x-forwarded-for unless configured to it explicitly.
  CLIENT_IP_HEADER: z.string().min(1).optional(),
  // SMTP for magic-link email (H-102); required in production (S8, fail loud).
  EMAIL_SERVER: z.string().optional(),
  // Optional first-admin bootstrap (H-102): while no ADMIN exists, a sign-in
  // with this verified email is promoted to ADMIN (audit entry written).
  INITIAL_ADMIN_EMAIL: z.string().min(3).optional(),
  EMAIL_FROM: z.string().default("HUK <no-reply@example.com>"),
  // Base URL under which the seed audio files are served (H-106). Files are
  // generated locally (scripts/seed-content) and served from public/seed/ in
  // development; production hosting is H-504.
  SEED_AUDIO_BASE_URL: z.string().min(1).optional(),
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
  // S4 (H-201): the outbound doors. http is NEVER allowed in production
  // code paths unless this dev/test flag is explicitly set.
  SAFE_FETCH_ALLOW_HTTP: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
  // S4 (H-201): the ports user-supplied URLs may target (comma-separated).
  SAFE_FETCH_PORTS: z
    .string()
    .default("443")
    .transform((s) =>
      s
        .split(",")
        .map((p) => Number(p.trim()))
        .filter((p) => Number.isInteger(p) && p > 0 && p < 65536),
    )
    .refine((ports) => ports.length > 0, "SAFE_FETCH_PORTS needs at least one valid port"),
  // S4/H-202: the Audius provider ships DISABLED (owner decision D3); no
  // default configuration may flip it on.
  AUDIUS_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
  // S4/H-202: source verification schedule and failure tolerance.
  SOURCE_FULL_HASH_DAYS: z.coerce.number().int().positive().default(7),
  SOURCE_MAX_FAILS: z.coerce.number().int().positive().default(5),
  SOURCE_VERIFY_BATCH: z.coerce.number().int().positive().default(20),
  // H-205: fingerprint stage. The AcoustID adapter ships DISABLED without
  // ACOUSTID_API_KEY (missing key ⇒ SKIPPED ⇒ never auto-approve); the
  // strong-match threshold is the auto-approval blocker (policy item 7).
  FINGERPRINT_STRONG_SCORE: z.coerce.number().min(0).max(1).default(0.9),
  // H-205: AudD is a paid provider — owner decision pending (D-family),
  // so no default configuration may flip it on (mirrors AUDIUS_ENABLED).
  AUDD_ENABLED: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(false),
  // H-205: AudD segments sampled per track (12 s each).
  AUDD_SEGMENTS: z.coerce.number().int().min(1).max(10).default(4),
  // H-112 (D14): broadcast audio cache. Required in production (S8): the
  // worker persists the window's audio files there. It must be an absolute
  // path OUTSIDE every served path — a `public` segment is refused outright.
  AUDIO_CACHE_DIR: z
    .string()
    .min(1)
    .refine(isSafeCacheDir, "AUDIO_CACHE_DIR must be an absolute path outside any served `public` directory")
    .optional(),
  // H-112 (D14): total bytes the broadcast cache may hold (default 400 MB).
  // When full the cache refuses new fetches loudly; in-window entries are
  // never evicted.
  AUDIO_CACHE_MAX_BYTES: z.coerce.number().int().positive().default(400 * 1024 * 1024),
});

export type Env = z.infer<typeof schema>;

/**
 * H-112 (D14): the broadcast cache directory must be absolute (it is a
 * container volume, not a web path) and must never sit inside a served
 * `public` directory — a cache file under the web root would be a stored
 * user-audio disclosure (S3).
 */
export function isSafeCacheDir(dir: string): boolean {
  if (!dir.startsWith("/")) return false;
  const segments = dir.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  if (segments.some((s) => s === "." || s === "..")) return false;
  return !segments.some((s) => s.toLowerCase() === "public");
}

// Settings that must be explicitly provided in production (H-103): the IP
// hashing salt and the trusted client-IP header name are identity/security
// parameters — a forgotten default would silently weaken S7.
const REQUIRED_IN_PRODUCTION = ["IP_HASH_SALT", "CLIENT_IP_HEADER", "EMAIL_SERVER", "AUDIO_CACHE_DIR"] as const;

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

  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !source[key]);
  if (parsed.data.NODE_ENV === "production" && missing.length > 0) {
    throw new Error(
      `Invalid environment (S8), refusing to start:\n${missing
        .map((k) => `  - ${k}: required in production (H-103)`)
        .join("\n")}`,
    );
  }

  // F1 (H-110): magic links must never point at http://localhost:3000 in
  // production — the base URL has to be a real https origin (S8, fail loud).
  if (
    parsed.data.NODE_ENV === "production" &&
    !parsed.data.NEXTAUTH_URL.startsWith("https://")
  ) {
    throw new Error(
      `Invalid environment (S8), refusing to start:\n  - NEXTAUTH_URL: must be an https:// URL in production (H-110)`,
    );
  }

  return parsed.data;
}

/** Production-only required settings get fixed dev defaults (H-103). */
export const DEV_DEFAULTS = {
  IP_HASH_SALT: "huk-dev-ip-hash-salt-do-not-use-in-prod" as string,
  CLIENT_IP_HEADER: "cf-connecting-ip" as string,
} as const;
