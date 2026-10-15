// H-120 done criterion: no hard-coded brand hex outside the token file
// (src/app/globals.css). The wordmark needs no exception — it draws its
// colours from the token classes.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["src/app/[locale]/layout.tsx", "src/app/[locale]/not-found.tsx", "src/components/shell", "src/components/ui"];
const HEX = /#[0-9a-fA-F]{3,8}\b/;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("dark tokens live in the token file only (H-120 task 1)", () => {
  it("no hard-coded hex colour in the H-120-owned sources (shell, ui, layout, 404)", () => {
    // Files OUTSIDE this naryad's scope keep their hex for now and are
    // listed in the H-120 report for the Auditor: the charts screens
    // (src/app/[locale]/charts/**, H-305), the moderator console and the
    // manifest — they move onto the tokens with their own naryads.
    const violations: string[] = [];
    for (const root of ROOTS) {
      const paths = statSync(root).isDirectory() ? files(root) : [root];
      for (const file of paths) {
        if (file.replace(/\\/g, "/").endsWith("src/app/globals.css")) continue; // the token file
        const source = readFileSync(file, "utf8");
        const lines = source.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (HEX.test(lines[i])) violations.push(`${file}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("globals.css is dark only (color-scheme: dark) and carries every role of TOKENS.md", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    expect(css).toMatch(/color-scheme:\s*dark/);
    for (const role of [
      "--background", "--surface", "--surface-sunken", "--surface-raised", "--border",
      "--text", "--text-muted", "--gold", "--gold-tint", "--success", "--danger",
      "--wordmark-grey", "--tagline-grey",
    ]) {
      expect(css).toContain(role);
    }
  });
});
