// H-120 task 6: catalog key parity — ru.json must contain the same key
// set as en.json (the source of truth), recursively.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";

function keySet(object: unknown, prefix = ""): string[] {
  if (typeof object !== "object" || object === null) return [prefix];
  return Object.entries(object as Record<string, unknown>).flatMap(([key, value]) =>
    keySet(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("catalog parity (H-120 task 6)", () => {
  it("messages/ru.json has exactly the same key set as messages/en.json", () => {
    const enKeys = keySet(en).sort();
    const ruKeys = keySet(ru).sort();
    expect(ruKeys).toEqual(enKeys);
  });

  it("no catalog value is an empty string (every visible string ships)", () => {
    for (const [locale, doc] of [["en", en], ["ru", ru]] as const) {
      for (const key of keySet(doc)) {
        const value = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], doc);
        expect(typeof value === "string" && value.trim() !== "", `${locale}:${key} -> ${JSON.stringify(value)}`).toBe(true);
      }
    }
  });
});
