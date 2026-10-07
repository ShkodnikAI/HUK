// H-201: the shared case table executed by BUN (the worker runtime).
// Run with: bun run test:bun-net
// Vitest must NOT pick this file up (its include is tests/**/*.test.ts,
// which does not match *.bun_test.ts); bun test discovers *_test.ts.
// @ts-expect-error bun:test resolves only under the bun runtime
import { test } from "bun:test";
import { cases } from "./table";

for (const c of cases) {
  test(c.name, () => c.run(), 30_000);
}
