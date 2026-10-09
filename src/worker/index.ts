// Worker entry (ARCHITECTURE §2): a single instance owns all scheduled work.
// H-104 scope: boot, validate env, run the broadcast scheduler (single writer
// via pg_try_advisory_lock), exit cleanly on SIGTERM with the lock released.

import { loadEnv } from "@/server/env";
import { startScheduler } from "@/server/broadcast/scheduler";
import { makeMaintenanceJobs } from "@/server/maintenance/jobs";
import { startMaintenance } from "@/server/maintenance/runner";
import { sweepStaleTempFiles } from "@/server/sources/verify";
import { runAudioCachePass, sweepCacheAtStartAsync } from "@/server/broadcast/audio-cache";
import { runModerationPass } from "@/server/moderation/orchestrator";
import { makeRankingJobs } from "@/server/ranking/job";

const env = loadEnv();

console.log(`[worker] booted pid=${process.pid} inviteOnly=${env.INVITE_ONLY}`);

// S3 (H-202): remove moderation temp dirs a crashed previous run left behind.
const swept = sweepStaleTempFiles();
if (swept > 0) console.log(`[worker] swept ${swept} stale moderation temp dirs`);

// H-112 (D14/S3): the broadcast cache directory is swept at start — anything
// not in the current broadcast window is deleted (the worker is the only
// writer and was down). In-window tracks survive the restart.
try {
  const cacheSwept = await sweepCacheAtStartAsync();
  if (cacheSwept > 0) console.log(`[worker] swept ${cacheSwept} stray broadcast-cache entries (H-112)`);
} catch (e) {
  console.error(`[worker] broadcast-cache sweep failed: ${e instanceof Error ? e.message : String(e)}`);
}

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
  clearInterval(cacheTimer);
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
// H-211 (G1): maintenance runs only while this process holds the broadcast
// advisory lock; a follower idles and re-checks every tick.
// H-304: the ranking and anti-fraud jobs ride the same gated runner.
const maintenance = startMaintenance({
  jobs: [...makeMaintenanceJobs(), ...makeRankingJobs()],
  isLeader: () => scheduler.isLeader(),
});

// H-204: the moderation cascade consumes PENDING tracks on a bounded tick.
// Non-overlapping in-process (a pass never starts while one runs); a pass
// with no eligible work costs one cheap DB query and is not audited.
const MODERATION_TICK_MS = 30_000;
const moderationTimer = setInterval(() => {
  // H-211 (G1): only the leadership holder consumes the moderation queue;
  // a follower idles and re-checks on the next tick.
  if (stopping || moderationInFlight || !scheduler.isLeader()) return;
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

// H-112 (D14): the broadcast audio cache — leader-only (the broadcast
// advisory lock held by this process is the gate, as for the scheduler),
// every 15 s, non-overlapping in-process.
const AUDIO_CACHE_TICK_MS = 15_000;
let cacheInFlight: Promise<unknown> | null = null;
const cacheTimer = setInterval(() => {
  if (stopping || cacheInFlight || !scheduler.isLeader()) return;
  cacheInFlight = runAudioCachePass()
    .then((summary) => {
      const active = summary.fetched + summary.failedSeries + summary.mismatched + summary.cacheFull + summary.skippedSlots + summary.evicted;
      if (active > 0) console.log(`[audio-cache] pass: ${JSON.stringify(summary)}`);
    })
    .catch((e) => console.error(`[audio-cache] pass failed: ${e instanceof Error ? e.message : String(e)}`))
    .finally(() => {
      cacheInFlight = null;
    });
}, AUDIO_CACHE_TICK_MS);
cacheTimer.unref?.();

void scheduler.done().then(() => {
  console.log("[worker] scheduler stopped; lock released");
});

// Keep the event loop alive until a termination signal arrives.
setInterval(() => {}, 1 << 30);
