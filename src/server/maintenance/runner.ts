// Worker maintenance job runner (H-210, S7): small, sequential, non-
// overlapping. The worker process is the single maintenance instance
// (ADR-0004 single-writer rule; the broadcast scheduler already owns the
// advisory lock in the same process), and the runner additionally guards
// against overlapping iterations in-process. Every job is idempotent and
// bounded per run; every run logs a one-line summary and writes an
// AuditLog entry with the counts.

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
}): MaintenanceRunner {
  const jobs = opts.jobs;
  const log = opts.log ?? ((line: string) => console.log(line));

  let stopped = false;
  let running = false;
  let inFlight: Promise<void> = Promise.resolve();
  const lastRun = new Map<string, number>();

  async function tick(): Promise<void> {
    if (running || stopped) return;
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
