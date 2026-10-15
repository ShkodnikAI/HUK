// The Node.js boot contract (H-107, H-306, H-309): everything register()
// must do in a REAL server process, extracted so that the Edge-runtime
// compilation of src/instrumentation.ts never includes a Node API in its
// module graph (the process.exit calls here made `next dev` print
// "A Node.js API is used (process.exit) ..." for the Edge Runtime — the
// warning is a compile-time property of the module graph, so a runtime
// NEXT_RUNTIME guard inside instrumentation.ts cannot silence it; keeping
// instrumentation.ts free of Node APIs does).
//
// Imported ONLY from register() after the NEXT_RUNTIME === 'nodejs' guard,
// so this module is evaluated exclusively in the Node.js server process.

import { loadEnv } from "@/server/env";
import { verifyDatabaseTimeZone, DatabaseTimeZoneError } from "@/server/db-timezone";

export async function boot(): Promise<void> {
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

  // H-306 (S9): after the env contract, verify the database time-zone
  // contract — the effective session zone must be UTC (the mechanism in
  // src/server/db-url.ts pins it on every pooled connection). A wrong zone
  // used to produce a silent station on non-UTC databases; refuse to start.
  try {
    await verifyDatabaseTimeZone();
  } catch (error) {
    if (error instanceof DatabaseTimeZoneError) {
      console.error(error.message);
      process.exit(1);
    }
    // A briefly unreachable database is not the time-zone contract: routes
    // fail closed per request and /api/health reports the outage. Log and
    // keep booting.
    console.error(
      `[boot] database time-zone check could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
