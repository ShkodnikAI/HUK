// Worker entry (ARCHITECTURE §2): a single instance owns all scheduled work.
// H-104 scope: boot, validate env, run the broadcast scheduler (single writer
// via pg_try_advisory_lock), exit cleanly on SIGTERM with the lock released.

import { loadEnv } from "@/server/env";
import { startScheduler } from "@/server/broadcast/scheduler";
import { makeMaintenanceJobs } from "@/server/maintenance/jobs";
import { startMaintenance } from "@/server/maintenance/runner";
import { sweepStaleTempFiles } from "@/server/sources/verify";
import { runModerationPass } from "@/server/moderation/orchestrator";

const env = loadEnv();

console.log(`[worker] booted pid=${process.pid} inviteOnly=${env.INVITE_ONLY}`);

// S3 (H-202): remove moderation temp dirs a crashed previous run left behind.
const swept = sweepStaleTempFiles();
if (swept > 0) console.log(`[worker] swept ${swept} stale moderation temp dirs`);

let stopping = false;

/** In-flight moderation pass, awaited on shutdown so a download finishes. */
let moderationInFlight: Promise<unknown> | null = null;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received — stopping scheduler`);
  await scheduler.stop(); // releases the advisory lock
  await maintenance.stop();
  clearInterval(moderationTimer);
  try {
    await moderationInFlight;
  } catch {
    /* the pass logs its own failures */
  }
  console.log("[worker] exiting cleanly");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log("[worker] broadcast scheduler started (H-104)");
const scheduler = startScheduler();

// H-210: retention and housekeeping jobs run in this same single-instance
// process, sequentially and non-overlapping (S7).
console.log("[worker] maintenance jobs started (H-210)");
const maintenance = startMaintenance({ jobs: makeMaintenanceJobs() });

// H-204: the moderation cascade consumes PENDING tracks on a bounded tick.
// Non-overlapping in-process (a pass never starts while one runs); a pass
// with no eligible work costs one cheap DB query and is not audited.
const MODERATION_TICK_MS = 30_000;
const moderationTimer = setInterval(() => {
  if (stopping || moderationInFlight) return;
  moderationInFlight = runModerationPass({ limit: 5, concurrency: 3 })
    .then((summary) => {
      if (summary.eligible > 0) console.log(`[moderation] pass: ${JSON.stringify(summary)}`);
    })
    .catch((e) => console.error(`[moderation] pass failed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      moderationInFlight = null;
    });
}, MODERATION_TICK_MS);
moderationTimer.unref?.();

void scheduler.done().then(() => {
  console.log("[worker] scheduler stopped; lock released");
});

// Keep the event loop alive until a termination signal arrives.
setInterval(() => {}, 1 << 30);
