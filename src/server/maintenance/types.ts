// Shared maintenance job type (H-210). Kept in its own module so the
// runner and the concrete job set do not import each other.

export type MaintenanceJob = {
  /** Stable identifier, used in summaries and audit entries. */
  name: string;
  /** Minimum time between two runs of this job (ms). */
  everyMs: number;
  /** One bounded, idempotent pass. Returns a one-line summary. */
  run: () => Promise<string>;
};
