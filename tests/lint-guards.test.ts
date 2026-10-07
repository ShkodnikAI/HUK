import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { ESLint } from "eslint";

// H-109 contract tests: every spelling of a direct environment read must be
// rejected by the no-restricted-syntax selectors in eslint.config.mjs when it
// appears in src/ outside the sanctioned reader; legitimate code, comments and
// strings must pass. Uses the ESLint Node API with the project's real flat
// config (cwd = repo root), so the tests exercise exactly what CI lints.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: repoRoot });

async function restrictedSyntaxErrors(filePath: string, code: string): Promise<string[]> {
  const results = await eslint.lintText(code, { filePath });
  return results.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-syntax").map((m) => m.message));
}

const TARGET = "src/app/page.tsx";

describe("S8 lint guard (H-109): forbidden spellings are rejected", () => {
  const cases: Array<[string, string]> = [
    ["process.env", "export const x = process.env.FOO;"],
    ['process["env"]', 'export const x = process["env"].FOO;'],
    ["globalThis.process.env", "export const x = globalThis.process.env.FOO;"],
    ["destructuring: const { env } = process", "const { env } = process;\nexport const x = env.FOO;"],
    ["aliasing: const p = process", "const p = process;\nexport const x = p.env.FOO;"],
    ["Bun.env", "export const x = Bun.env.FOO;"],
    ["import.meta.env", "export const x = import.meta.env.FOO;"],
    ["Deno.env", "export const x = Deno.env.FOO;"],
  ];

  for (const [spelling, code] of cases) {
    it(`rejects ${spelling}`, async () => {
      const errors = await restrictedSyntaxErrors(TARGET, code);
      expect(errors, `expected a no-restricted-syntax error for: ${spelling}`).toHaveLength(1);
      expect(errors[0]).toContain("loadEnv()");
    });
  }
});

describe("S8 lint guard (H-109): legitimate code passes", () => {
  it("accepts loadEnv() usage in src/", async () => {
    const errors = await restrictedSyntaxErrors(
      TARGET,
      'import { loadEnv } from "@/server/env";\nconst env = loadEnv();\nexport const x = env.AUTH_URL;',
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts a comment mentioning the banned phrase (H-107 v1 false positive)", async () => {
    const errors = await restrictedSyntaxErrors(
      TARGET,
      "// never read process.env directly; use loadEnv()\nexport const x = 1;",
    );
    expect(errors).toHaveLength(0);
  });

  it("accepts the phrase inside a string literal", async () => {
    const errors = await restrictedSyntaxErrors(
      TARGET,
      'export const doc = "process.env is banned outside src/server/env.ts";',
    );
    expect(errors).toHaveLength(0);
  });

  it("allows every spelling inside the sanctioned reader src/server/env.ts", async () => {
    const errors = await restrictedSyntaxErrors(
      "src/server/env.ts",
      "export const a = process.env.FOO;\nexport const b = Bun.env.FOO;\nconst { env } = process;\nexport const c = env.FOO;",
    );
    expect(errors).toHaveLength(0);
  });

  it("the real src/instrumentation.ts passes (single marked exception, inline disable)", async () => {
    const code = readFileSync(join(repoRoot, "src/instrumentation.ts"), "utf8");
    const errors = await restrictedSyntaxErrors("src/instrumentation.ts", code);
    expect(errors).toHaveLength(0);
  });
});
