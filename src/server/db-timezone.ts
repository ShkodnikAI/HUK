// H-306 boot check (S8/S9, fail loud). The connection mechanism
// (src/server/db-url.ts) pins every session to UTC via the startup packet;
// this module verifies the EFFECTIVE zone on the first connection and lets
// web and worker refuse to start when it is not UTC. The field incident
// (2026-10-15) was a silent station on a Europe/Minsk database — a wrong
// zone must stop the boot, not degrade the timeline quietly.

import type { PrismaClient } from "@prisma/client";
import { db } from "@/server/db";

type TimeZoneClient = Pick<PrismaClient, "$queryRaw">;

/** One-line operator guidance attached to every time-zone refusal. */
export const DB_TIMEZONE_FIX =
  "Fix: every connection must run in UTC. The app appends `options=-c timezone=UTC` " +
  "to DATABASE_URL automatically — a non-UTC effective zone means the parameter did " +
  "not reach this database. Check the URL/server (a proxy or a pooled endpoint may " +
  "strip it), or run `ALTER DATABASE <huk> SET timezone TO 'UTC'`, then restart.";

/** Thrown when the effective session time zone is not exactly UTC. */
export class DatabaseTimeZoneError extends Error {
  /** The zone PostgreSQL reported, e.g. `Europe/Minsk`. */
  readonly observedZone: string;

  constructor(observedZone: string) {
    super(
      `Database session time zone is '${observedZone}', expected 'UTC' (H-306, S9 fail loud). ${DB_TIMEZONE_FIX}`,
    );
    this.name = "DatabaseTimeZoneError";
    this.observedZone = observedZone;
  }
}

/**
 * The effective time zone of one connection from the client's pool — the
 * programmatic equivalent of `SHOW timezone` (the same `TimeZone` GUC).
 */
export async function effectiveDatabaseTimeZone(client: TimeZoneClient = db): Promise<string> {
  const rows = await client.$queryRaw<Array<{ timezone: string }>>`
    SELECT current_setting('TimeZone') AS "timezone"
  `;
  return rows[0]?.timezone ?? "";
}

/**
 * Resolves when the effective session zone is exactly `UTC`; throws
 * {@link DatabaseTimeZoneError} otherwise. Connection failures propagate to
 * the caller (a briefly unreachable database is not the time-zone contract —
 * see the boot wiring in src/instrumentation.ts and src/worker/index.ts).
 */
export async function verifyDatabaseTimeZone(client: TimeZoneClient = db): Promise<void> {
  const zone = await effectiveDatabaseTimeZone(client);
  if (zone !== "UTC") {
    throw new DatabaseTimeZoneError(zone === "" ? "(empty)" : zone);
  }
}
