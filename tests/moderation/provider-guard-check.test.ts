import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// H-204 done criterion: the new CI check is red on a planted adapter call
// outside guard, and green on the shipped adapter set. The probe runs the
// real script (scripts/ci/check-provider-guard.mjs) against a fixture tree.

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(repoRoot, "scripts", "ci", "check-provider-guard.mjs");
const SHIPPED_ADAPTERS = join(repoRoot, "src", "server", "moderation", "adapters");

function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "huk-guardcheck-"));
  mkdirSync(join(root, "src", "server", "moderation", "adapters"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "src", "server", "moderation", "adapters", name), content, "utf8");
  }
  return root;
}

function runCheck(root: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--root", root], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const CLEAN_ADAPTER = `import { guardedProviderFetch } from "../provider-fetch";
export async function lookup(url: string) {
  return guardedProviderFetch(url, { provider: "x", estimateMicroUsd: 10 });
}
`;

describe("H-204 provider-guard CI check", () => {
  it("is green on the shipped adapter set (root run)", () => {
    const res = runCheck(repoRoot);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("0 violations");
  });

  it("stays green when only the gate module exists", () => {
    const root = mkdtempSync(join(tmpdir(), "huk-guardcheck-"));
    try {
      mkdirSync(join(root, "src", "server", "moderation", "adapters"), { recursive: true });
      copyFileSync(join(SHIPPED_ADAPTERS, "provider-fetch.ts"), join(root, "src", "server", "moderation", "adapters", "provider-fetch.ts"));
      const res = runCheck(root);
      expect(res.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is red on a planted direct trustedFetch call in an adapter", () => {
    const root = makeTree({
      "provider-fetch.ts": "// stub gate (not scanned as the gate is matched by name)\n",
      "evil.ts": `import { trustedFetch } from "@/server/net/trusted-fetch";
export async function evil(url: string) {
  return trustedFetch(url);
}
`,
    });
    try {
      const res = runCheck(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("evil.ts");
      expect(res.stderr).toContain("guardedProviderFetch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is red on an adapter that merely imports trustedFetch (even without calling it)", () => {
    const root = makeTree({
      "sneaky.ts": `import { trustedFetch } from "@/server/net/trusted-fetch";
export const ready = true;
`,
    });
    try {
      const res = runCheck(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("sneaky.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is red when the gate loses its guard wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "huk-guardcheck-"));
    try {
      mkdirSync(join(root, "src", "server", "moderation", "adapters"), { recursive: true });
      writeFileSync(
        join(root, "src", "server", "moderation", "adapters", "provider-fetch.ts"),
        `import { trustedFetch } from "@/server/net/trusted-fetch";
export async function unguarded(url: string) {
  return trustedFetch(url);
}
`,
        "utf8",
      );
      const res = runCheck(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("outside a guard(");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is red when the gate has no trustedFetch door at all", () => {
    const root = mkdtempSync(join(tmpdir(), "huk-guardcheck-"));
    try {
      mkdirSync(join(root, "src", "server", "moderation", "adapters"), { recursive: true });
      writeFileSync(join(root, "src", "server", "moderation", "adapters", "provider-fetch.ts"), "export const x = 1;\n", "utf8");
      const res = runCheck(root);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("lost its guarded trustedFetch call");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a clean adapter that uses guardedProviderFetch", () => {
    const root = makeTree({
      "provider-fetch.ts": `import { guard } from "@/server/budget";
import { trustedFetch } from "@/server/net/trusted-fetch";
export async function guardedProviderFetch(url: string) {
  return guard({ provider: "x", estimateMicroUsd: 1 }, async () => {
    const res = await trustedFetch(url);
    return { result: res, costMicroUsd: 1 };
  });
}
`,
      "clean.ts": CLEAN_ADAPTER,
    });
    try {
      const res = runCheck(root);
      expect(res.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
