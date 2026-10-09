// H-402 static checks: the vocabulary data files are well-formed (42/10/42,
// slug charset, style parents are real directions), the message catalogs
// carry a label for every slug in both languages, and the LANGUAGE term
// derivation follows the BCP-47 primary subtag rule (pt-BR → pt, unlisted
// → other). No DB involved.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DIRECTIONS,
  LANGUAGES,
  STYLES,
  isDirectionSlug,
  isStyleSlug,
  languageTermSlug,
  primarySubtag,
  vocabularyTerms,
} from "@/server/taxonomy/vocabulary";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

describe("taxonomy vocabulary (H-402)", () => {
  it("has the Owner-approved sizes: 42 languages, 10 directions, 42 styles", () => {
    expect(Object.keys(LANGUAGES)).toHaveLength(42);
    expect(Object.keys(DIRECTIONS)).toHaveLength(10);
    expect(Object.keys(STYLES)).toHaveLength(42);
  });

  it("uses lowercase slugs only, in every kind", () => {
    for (const slug of Object.keys(LANGUAGES)) expect(SLUG.test(slug), slug).toBe(true);
    for (const slug of Object.keys(DIRECTIONS)) expect(SLUG.test(slug), slug).toBe(true);
    for (const slug of Object.keys(STYLES)) expect(SLUG.test(slug), slug).toBe(true);
  });

  it("binds every style to an existing direction (parent invariant)", () => {
    for (const [slug, def] of Object.entries(STYLES)) {
      expect(DIRECTIONS[def.parent], `${slug} → ${def.parent}`).toBeTruthy();
    }
    // And the grouping in the data file matches the flattened view.
    const file = JSON.parse(readFileSync("prisma/taxonomy/styles.json", "utf8")) as Record<string, Record<string, string>>;
    for (const [parent, group] of Object.entries(file)) {
      for (const [slug, label] of Object.entries(group)) {
        expect(STYLES[slug]).toEqual({ label, parent });
      }
    }
  });

  it("carries non-empty English labels from the data files", () => {
    for (const label of Object.values(LANGUAGES)) expect(label.length).toBeGreaterThan(0);
    for (const label of Object.values(DIRECTIONS)) expect(label.length).toBeGreaterThan(0);
    for (const def of Object.values(STYLES)) expect(def.label.length).toBeGreaterThan(0);
  });

  it("derives the LANGUAGE term from the BCP-47 primary subtag", () => {
    expect(primarySubtag("pt-BR")).toBe("pt");
    expect(languageTermSlug("pt-BR")).toBe("pt");
    expect(languageTermSlug("en-US")).toBe("en");
    expect(languageTermSlug("ru")).toBe("ru");
    expect(languageTermSlug("PT-br")).toBe("pt"); // case-insensitive
    expect(languageTermSlug("zza")).toBe("other"); // unlisted language
    expect(languageTermSlug("qaa")).toBe("other");
  });

  it("rejects unknown slugs and resolves validated refs to full rows", () => {
    expect(isStyleSlug("synthwave")).toBe(true);
    expect(isStyleSlug("nonexistent")).toBe(false);
    expect(isDirectionSlug("electronic")).toBe(true);
    expect(isDirectionSlug("discovery")).toBe(false);

    const rows = vocabularyTerms([
      { kind: "LANGUAGE", slug: "pt" },
      { kind: "STYLE", slug: "synthwave" },
      { kind: "DIRECTION", slug: "electronic" },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "LANGUAGE", slug: "pt", parentId: null });
    expect(rows[1]).toMatchObject({ kind: "STYLE", slug: "synthwave", parentId: "electronic" });
    expect(rows[2]).toMatchObject({ kind: "DIRECTION", slug: "electronic", parentId: null });
  });
});

describe("taxonomy message catalogs (H-402)", () => {
  const en = JSON.parse(readFileSync("messages/en.json", "utf8")) as { taxonomy: Record<string, Record<string, string>> };
  const ru = JSON.parse(readFileSync("messages/ru.json", "utf8")) as { taxonomy: Record<string, Record<string, string>> };

  it("has taxonomy.<kind>.<slug> for every vocabulary slug, in en and ru", () => {
    for (const slug of Object.keys(LANGUAGES)) {
      expect(en.taxonomy.language[slug], `en language ${slug}`).toBeTruthy();
      expect(ru.taxonomy.language[slug], `ru language ${slug}`).toBeTruthy();
    }
    for (const slug of Object.keys(DIRECTIONS)) {
      expect(en.taxonomy.direction[slug], `en direction ${slug}`).toBeTruthy();
      expect(ru.taxonomy.direction[slug], `ru direction ${slug}`).toBeTruthy();
    }
    for (const slug of Object.keys(STYLES)) {
      expect(en.taxonomy.style[slug], `en style ${slug}`).toBeTruthy();
      expect(ru.taxonomy.style[slug], `ru style ${slug}`).toBeTruthy();
    }
  });

  it("keeps no extra keys beyond the vocabulary", () => {
    expect(Object.keys(en.taxonomy.language)).toHaveLength(42);
    expect(Object.keys(en.taxonomy.direction)).toHaveLength(10);
    expect(Object.keys(en.taxonomy.style)).toHaveLength(42);
    expect(Object.keys(ru.taxonomy.language)).toHaveLength(42);
    expect(Object.keys(ru.taxonomy.direction)).toHaveLength(10);
    expect(Object.keys(ru.taxonomy.style)).toHaveLength(42);
  });
});
