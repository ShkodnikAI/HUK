// Taxonomy vocabulary (H-402): the controlled vocabulary lives as data
// files in prisma/taxonomy/ and is the single source of truth. The seed
// bulk-loads it into TaxonomyTerm; the submission and moderator paths
// validate against it and upsert the exact rows they need, so the DB
// mirror can never drift from the files. Changing a list later is a data
// change plus a naryad (Owner decision 2026-10-08) — never a rewrite.

import languagesJson from "../../../prisma/taxonomy/languages.json";
import directionsJson from "../../../prisma/taxonomy/directions.json";
import stylesJson from "../../../prisma/taxonomy/styles.json";

/** LANGUAGE: the language of the vocals (ISO 639-1); `other` covers any language not listed. */
export const LANGUAGES: Readonly<Record<string, string>> = languagesJson;

/** DIRECTION: the broad genre family. */
export const DIRECTIONS: Readonly<Record<string, string>> = directionsJson;

/**
 * STYLE: a sub-genre, always with a DIRECTION as its parent. The data file
 * groups styles under their direction; this flattens to slug → {label,
 * parent} while keeping the file readable and the parent structural.
 */
export const STYLES: Readonly<Record<string, { label: string; parent: string }>> = Object.freeze(
  Object.fromEntries(
    Object.entries(stylesJson).flatMap(([parent, group]) =>
      Object.entries(group).map(([slug, label]) => [slug, { label, parent }]),
    ),
  ),
);

export type TermKind = "LANGUAGE" | "STYLE" | "DIRECTION";

export const STYLE_DIRECTION_PARENTS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(STYLES).map(([slug, def]) => [slug, def.parent]),
);

export function isLanguageSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, slug);
}

export function isDirectionSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIRECTIONS, slug);
}

export function isStyleSlug(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(STYLES, slug);
}

/** The primary subtag of a BCP-47 tag: `pt-BR` → `pt` (case-insensitive). */
export function primarySubtag(tag: string): string {
  return (tag.split("-")[0] ?? "").toLowerCase();
}

/**
 * The LANGUAGE term for a track: the primary subtag when it is in the
 * vocabulary, otherwise `other` (vocals in a language not listed).
 * Instrumental tracks get no language term (the flag stays on the track).
 */
export function languageTermSlug(tag: string): string {
  const primary = primarySubtag(tag);
  return isLanguageSlug(primary) ? primary : "other";
}

/** A vocabulary row the DB mirror must contain for `kind`+`slug`. */
export type VocabularyTerm = { kind: TermKind; slug: string; label: string; parentId: string | null };

/**
 * Resolves validated term references to full vocabulary rows (label and
 * style parent included). Only called with slugs that passed the
 * vocabulary checks, so every lookup succeeds — a programming error,
 * not a user input problem, if it does not.
 */
export function vocabularyTerms(refs: ReadonlyArray<{ kind: TermKind; slug: string }>): VocabularyTerm[] {
  return refs.map((ref) => {
    if (ref.kind === "LANGUAGE") {
      const label = LANGUAGES[ref.slug];
      if (label === undefined) throw new Error(`vocabulary bug: unknown LANGUAGE slug ${ref.slug}`);
      return { kind: ref.kind, slug: ref.slug, label, parentId: null };
    }
    if (ref.kind === "DIRECTION") {
      const label = DIRECTIONS[ref.slug];
      if (label === undefined) throw new Error(`vocabulary bug: unknown DIRECTION slug ${ref.slug}`);
      return { kind: ref.kind, slug: ref.slug, label, parentId: null };
    }
    const def = STYLES[ref.slug];
    if (def === undefined) throw new Error(`vocabulary bug: unknown STYLE slug ${ref.slug}`);
    return { kind: ref.kind, slug: ref.slug, label: def.label, parentId: def.parent };
  });
}
