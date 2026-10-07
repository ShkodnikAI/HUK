import { PrismaClient } from "@prisma/client";

// DB integration harness (H-101).
// - DATABASE_URL unset → the suites are skipped with an explicit message
//   (printed at collection time in db.test.ts / seed.test.ts).
// - DATABASE_URL set but unreachable → the connect test fails loudly with the
//   underlying error (nothing is swallowed).

export const databaseUrl = process.env.DATABASE_URL;

export function skipMessage(): string {
  return "[tests/db] DATABASE_URL is not set — DB integration tests are SKIPPED (they run in CI and locally with a real Postgres)";
}

/** A client bound to DATABASE_URL directly (tests are not runtime code). */
export function makeClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}

/**
 * Truncates every table of the public schema except the Prisma migration
 * bookkeeping. CASCADE so FK order does not matter; RESTART IDENTITY keeps
 * runs reproducible. Resolved dynamically so the helper survives schema
 * growth without edits.
 */
export async function cleanTables(client: PrismaClient): Promise<void> {
  const rows = await client.$queryRawUnsafe<Array<{ tables: string | null }>>(
    `SELECT string_agg(format('%I', tablename), ', ') AS tables
       FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  const tables = rows[0]?.tables;
  if (tables) {
    await client.$executeRawUnsafe(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }
}
