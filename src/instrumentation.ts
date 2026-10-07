// Next.js instrumentation hook: register() runs once when the server instance
// boots, before it serves traffic. HUK uses it to enforce S8 — the environment
// is validated at boot in EVERY process, not only in the worker (H-107; before
// this file, `next start` with an empty env happily served /api/health 200).
//
// Node runtime only. HUK defines no edge code — no middleware.ts, no
// `runtime = "edge"` route handlers (verified by grep in H-107) — so this hook
// executes exclusively in the Node.js server process.
//
// Must not run during `next build`: the build has no runtime environment to
// validate, and a failure there would be the wrong signal (S8 is a boot-time,
// runtime contract). Next.js sets NEXT_PHASE=phase-production-build for the
// duration of the build; the guard below turns register() into a no-op then.

export async function register(): Promise<void> {
  // The ONLY direct read of the process environment permitted outside
  // src/server/env.ts (enforced by scripts/ci/check-no-process-env.mjs and
  // by the AST-level no-restricted-syntax selectors in eslint.config.mjs).
  // Purpose: skip env validation at build time; `next start` and `next dev`
  // never set phase-production-build, so validation always runs in a server
  // process. The marker H-107-EXCEPTION must stay on the same line as the
  // guarded read — the CI guard counts marked occurrences and keeps the
  // exception single.
  // eslint-disable-next-line no-restricted-syntax -- the single documented S8 exception (H-107, H-109)
  if (process.env.NEXT_PHASE === "phase-production-build") return; // H-107-EXCEPTION

  const { loadEnv } = await import("@/server/env");
  try {
    loadEnv();
  } catch (error) {
    // Fail loud (S9): Next.js demotes an instrumentation rejection to an
    // unhandledRejection and keeps the process alive — every request degrades
    // to a 500. A broken environment must stop the boot instead (S8): print
    // the validation error and exit non-zero.
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
