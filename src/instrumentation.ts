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
//
// H-309: this file is analysed (and compiled) for BOTH runtimes, so every
// Node.js API in it made `next dev` print "A Node.js API is used
// (process.exit) ... not supported in the Edge Runtime" — a compile-time
// property of the module graph that NO runtime guard can silence. The whole
// Node.js boot contract therefore lives in src/server/boot.ts and is
// dynamically imported here only AFTER the runtime guard — instrumentation.ts
// itself stays free of Node APIs, and the boot contract (S8 + the H-306
// database time-zone check) still runs in every Node server process.

export async function register(): Promise<void> {
  // The ONLY direct read of the process environment permitted outside
  // src/server/env.ts (enforced by scripts/ci/check-no-process-env.mjs and
  // by the AST-level no-restricted-syntax selectors in eslint.config.mjs).
  // Purpose: skip the boot contract at build time and in non-Node runtimes;
  // `next start` and `next dev` never set phase-production-build and run
  // with NEXT_RUNTIME=nodejs, so the contract always runs in a server
  // process. The marker H-107-EXCEPTION must stay on the same line as the
  // guarded read — the CI guard counts marked occurrences and keeps the
  // exception single.
  // eslint-disable-next-line no-restricted-syntax -- the single documented S8 exception (H-107, H-109, H-309)
  if (process.env.NEXT_PHASE === "phase-production-build" || process.env.NEXT_RUNTIME !== "nodejs") return; // H-107-EXCEPTION

  const { boot } = await import("@/server/boot");
  await boot();
}
