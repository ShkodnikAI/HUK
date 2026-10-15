// H-306: unit tests for the boot check in src/server/db-timezone.ts —
// a mocked non-UTC effective zone must produce DatabaseTimeZoneError with
// the one-line fix message (S9); UTC resolves; connection errors propagate.

import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import {
  DB_TIMEZONE_FIX,
  DatabaseTimeZoneError,
  effectiveDatabaseTimeZone,
  verifyDatabaseTimeZone,
} from "@/server/db-timezone";

/** A $queryRaw-only client stub answering with the given rows. */
function stubClient(rows: unknown): Pick<PrismaClient, "$queryRaw"> {
  return { $queryRaw: (async () => rows) as never } as Pick<PrismaClient, "$queryRaw">;
}

describe("database time-zone boot check (H-306)", () => {
  it("reads the effective zone (the programmatic SHOW timezone)", async () => {
    const client = stubClient([{ timezone: "Europe/Minsk" }]);
    await expect(effectiveDatabaseTimeZone(client)).resolves.toBe("Europe/Minsk");
  });

  it("resolves when the effective zone is exactly UTC", async () => {
    await expect(verifyDatabaseTimeZone(stubClient([{ timezone: "UTC" }]))).resolves.toBeUndefined();
  });

  it("throws DatabaseTimeZoneError with the fix message for a non-UTC zone", async () => {
    const promise = verifyDatabaseTimeZone(stubClient([{ timezone: "Europe/Minsk" }]));
    await expect(promise).rejects.toBeInstanceOf(DatabaseTimeZoneError);
    await expect(promise).rejects.toThrow(/Database session time zone is 'Europe\/Minsk', expected 'UTC'/);
    await expect(promise).rejects.toThrow(/Fix:/);
    // The fix hint itself carries the operator instruction.
    expect(DB_TIMEZONE_FIX).toContain("options=-c timezone=UTC");
    expect(DB_TIMEZONE_FIX).toContain("ALTER DATABASE");
  });

  it("treats an unreadable zone as non-UTC (fail closed)", async () => {
    await expect(verifyDatabaseTimeZone(stubClient([]))).rejects.toBeInstanceOf(DatabaseTimeZoneError);
  });

  it("propagates connection errors untouched (not a time-zone refusal)", async () => {
    const broken = {
      $queryRaw: async () => {
        const e = new Error("connect ECONNREFUSED 127.0.0.1:5432") as Error & { code: string };
        e.code = "ECONNREFUSED";
        throw e;
      },
    } as unknown as Pick<PrismaClient, "$queryRaw">;
    await expect(verifyDatabaseTimeZone(broken)).rejects.toThrow(/ECONNREFUSED/);
    await expect(verifyDatabaseTimeZone(broken)).rejects.not.toBeInstanceOf(DatabaseTimeZoneError);
  });
});
