import { PrismaClient } from "@prisma/client";
import { loadEnv } from "@/server/env";
import { withUtcTimeZone } from "@/server/db-url";

// Prisma client singleton (H-101).
//
// - S8: the connection URL comes only from loadEnv() — never from raw
//   process.env (enforced by scripts/ci/check-no-process-env.mjs and the
//   eslint no-restricted-syntax selectors).
// - Dev hot-reload safe: the client lives on globalThis, so Next's dev server
//   does not open a new pool on every module reload.
// - Lazy: route modules are imported during `next build` (route collection)
//   when there is no runtime environment to validate (H-107). The client —
//   and therefore the S8 validation — is created on first actual use, not at
//   import time.

const globalForDb = globalThis as unknown as { __hukPrisma?: PrismaClient };

function createClient(): PrismaClient {
  const env = loadEnv();
  // H-306: every pooled connection this client ever opens carries the
  // startup-packet parameter `options=-c timezone=UTC` (src/server/db-url.ts
  // explains why the session zone is load-bearing for naive timestamp
  // columns). The datasource URL is the single choke point — there is no
  // Prisma connection in the codebase that bypasses this constructor.
  return new PrismaClient({ datasourceUrl: withUtcTimeZone(env.DATABASE_URL) });
}

export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    globalForDb.__hukPrisma ??= createClient();
    const client = globalForDb.__hukPrisma;
    const value = Reflect.get(client, prop);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
  has(_target, prop) {
    globalForDb.__hukPrisma ??= createClient();
    return Reflect.has(globalForDb.__hukPrisma, prop);
  },
});

/** Closes the pool; used by the worker on SIGTERM. */
export async function disconnect(): Promise<void> {
  await globalForDb.__hukPrisma?.$disconnect();
  globalForDb.__hukPrisma = undefined;
}
