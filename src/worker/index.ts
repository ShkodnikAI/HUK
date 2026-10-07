// Worker entry (ARCHITECTURE §2): a single instance owns all scheduled work.
// H-104 scope: boot, validate env, run the broadcast scheduler (single writer
// via pg_try_advisory_lock), exit cleanly on SIGTERM with the lock released.

import { loadEnv } from "@/server/env";
import { startScheduler } from "@/server/broadcast/scheduler";
import { makeMaintenanceJobs } from "@/server/maintenance/jobs";
import { startMaintenance } from "@/server/maintenance/runner";

const env = loadEnv();

console.log(`[worker] booted pid=${process.pid} inviteOnly=${env.INVITE_ONLY}`);

let stopping = false;

async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} received — stopping scheduler`);
  await scheduler.stop(); // releases the advisory lock
  await maintenance.stop();
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

void scheduler.done().then(() => {
  console.log("[worker] scheduler stopped; lock released");
});

// Keep the event loop alive until a termination signal arrives.
setInterval(() => {}, 1 << 30);
