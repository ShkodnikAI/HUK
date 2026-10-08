// Worker maintenance job runner (H-210, S7): small, sequential, non-
// overlapping. H-211 (G1): the runner also honours an injectable leadership
// gate — in the worker process it is `scheduler.isLeader()`, so only the
// advisory-lock owner runs maintenance; a follower idles and re-checks every
// tick. The runner additionally guards against overlapping iterations
// in-process. Every job is idempotent and bounded per run; every run logs a
// one-line summary and writes an AuditLog entry with the counts.

import { audit } from "@/server/audit";
import type { MaintenanceJob } from "./types";

export type { MaintenanceJob } from "./types";

export type MaintenanceRunner = {
  stop: () => Promise<void>;
};

export function startMaintenance(opts: {
  jobs: MaintenanceJob[];
  tickMs?: number;
  log?: (line: string) => void;
  /** H-211 (G1): when provided and returning false, the tick is skipped —
   * a follower idles and re-checks on the next tick. Omitted in tests that
   * run a runner without a scheduler. */
  isLeader?: () => boolean;
}): MaintenanceRunner {
  const jobs = opts.jobs;
  const log = opts.log ?? ((line: string) => console.log(line));
  const isLeader = opts.isLeader;

  let stopped = false;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();
  const lastRun = new Map<string, number>();

  async function tick(): Promise<void> {
    if (running || stopped) return;
    // H-211 (G1): only the leadership holder runs maintenance jobs.
    if (isLeader && !isLeader()) return; // follower: idle, re-check next tick
    running = true;
    try {
      for (const job of jobs) {
        if (stopped) return;
        const last = lastRun.get(job.name) ?? 0;
        if (Date.now() - last < job.everyMs) continue;
        lastRun.set(job.name, Date.now());
        const summary = await job.run();
        log(`[maintenance] ${job.name}: ${summary}`);
        await audit({
          actorKind: "worker",
          action: `maintenance.${job.name}`,
          targetType: "System",
          targetId: job.name,
          payload: { summary },
        });
      }
    } catch (error) {
      // A failing maintenance job must never take the worker down: the
      // failure is logged loudly and the next tick retries (S9).
      log(`[maintenance] run failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    // Chain ticks so an in-flight pass always finishes before the next one
    // starts; the `running` flag inside tick() is the second guard.
    inFlight = inFlight.then(() => tick()).catch(() => {});
  }, opts.tickMs ?? 60_000);
  inFlight = inFlight.then(() => tick()).catch(() => {}); // first pass at boot

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight; // let the in-flight pass (incl. its audit write) finish
    },
  };
}
