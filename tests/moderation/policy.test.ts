import { describe, expect, it } from "vitest";
import { loadPolicy, resetPolicyCache } from "@/server/moderation/policy";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// H-204 task 2: the policy loader reads policy/moderation-policy.md at
// start-up, derives policyVersion from its SHA-256 and fails loud (S9)
// when the file is missing or empty.

describe("H-204 policy loader", () => {
  it("derives policyVersion from the content hash", () => {
    resetPolicyCache();
    const text = "# Test policy\nRemove: blatant crime.";
    const p = loadPolicy({ text });
    expect(p.text).toBe(text);
    expect(p.version).toBe(`sha256:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`);
  });

  it("caches the loaded policy until forceReload", () => {
    resetPolicyCache();
    const a = loadPolicy({ text: "policy A" });
    const cached = loadPolicy({ text: "policy B" });
    expect(cached.version).toBe(a.version);
    const reloaded = loadPolicy({ text: "policy B", forceReload: true });
    expect(reloaded.version).not.toBe(a.version);
    resetPolicyCache();
  });

  it("reads a file from disk (worker layout)", () => {
    resetPolicyCache();
    const dir = mkdtempSync(join(tmpdir(), "huk-policy-"));
    const file = join(dir, "moderation-policy.md");
    try {
      writeFileSync(file, "# File policy\ncontent", "utf8");
      const p = loadPolicy({ path: file });
      expect(p.text).toBe("# File policy\ncontent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loud on a missing file (S9)", () => {
    expect(() => loadPolicy({ path: "/nonexistent/policy/moderation-policy.md", forceReload: true })).toThrow();
    resetPolicyCache();
  });

  it("fails loud on an empty policy (S9)", () => {
    expect(() => loadPolicy({ text: "   \n  ", forceReload: true })).toThrow(/empty/);
    resetPolicyCache();
  });
});
