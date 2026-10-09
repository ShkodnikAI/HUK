// Chart category keys (H-305, ARCHITECTURE §9): the TrackScore dimension
// the charts read. A track's categories derive from its confirmed terms
// (H-402) and its instrumental flag:
//   all | instrumental | lang:<code> | style:<slug> | direction:<slug>
//   lang:<code>+style:<slug>
// The language code is the LANGUAGE term slug — the same derivation as the
// submission path (BCP-47 primary subtag, unlisted → other, instrumental
// tracks have none). Publishing a category needs at least
// PUBLISHED_MIN_TRACKS chart-eligible tracks; smaller categories roll up
// into their parents (their tracks stay in `all`).

import type { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";
import {
  isDirectionSlug,
  isLanguageSlug,
  isStyleSlug,
  languageTermSlug,
} from "@/server/taxonomy/vocabulary";
import { MIN_VOTERS } from "@/server/ranking/signals";

/** A category with fewer eligible tracks than this is not listed. */
export const PUBLISHED_MIN_TRACKS = 20;

export type ChartTrackShape = {
  language: string | null;
  instrumental: boolean;
  terms: Array<{ kind: "LANGUAGE" | "STYLE" | "DIRECTION"; slug: string }>;
};

/** The exact category-key set for one track (pure, shared by tests). */
export function categoryKeysForTrack(track: ChartTrackShape): string[] {
  const keys = ["all"];
  if (track.instrumental) keys.push("instrumental");
  const lang = track.instrumental ? null : languageTermSlug(track.language ?? "");
  if (lang) keys.push(`lang:${lang}`);
  let style: string | null = null;
  for (const term of track.terms) {
    if (term.kind === "STYLE") {
      style = term.slug;
      keys.push(`style:${term.slug}`);
    } else if (term.kind === "DIRECTION") {
      keys.push(`direction:${term.slug}`);
    }
    // LANGUAGE terms confirm the derived code; the key itself comes from
    // Track.language via the same function, so no key is added here.
  }
  if (lang && style) keys.push(`lang:${lang}+style:${style}`);
  return keys;
}

const LANG_PREFIX = "lang:";
const STYLE_PREFIX = "style:";
const DIRECTION_PREFIX = "direction:";
const COMBO_SEPARATOR = "+";

export type ParsedCategory =
  | { kind: "all" }
  | { kind: "instrumental" }
  | { kind: "language"; slug: string }
  | { kind: "style"; slug: string }
  | { kind: "direction"; slug: string }
  | { kind: "lang+style"; lang: string; style: string };

/**
 * Validates a category key against the controlled vocabulary (H-402).
 * Unknown slugs and malformed keys are 404s — fail closed (S9).
 */
export function parseCategoryKey(key: string): ParsedCategory | null {
  if (key === "all") return { kind: "all" };
  if (key === "instrumental") return { kind: "instrumental" };
  const parts = key.split(COMBO_SEPARATOR);
  if (parts.length === 1) {
    if (key.startsWith(LANG_PREFIX) && isLanguageSlug(key.slice(LANG_PREFIX.length))) {
      return { kind: "language", slug: key.slice(LANG_PREFIX.length) };
    }
    if (key.startsWith(STYLE_PREFIX) && isStyleSlug(key.slice(STYLE_PREFIX.length))) {
      return { kind: "style", slug: key.slice(STYLE_PREFIX.length) };
    }
    if (key.startsWith(DIRECTION_PREFIX) && isDirectionSlug(key.slice(DIRECTION_PREFIX.length))) {
      return { kind: "direction", slug: key.slice(DIRECTION_PREFIX.length) };
    }
    return null;
  }
  if (parts.length === 2) {
    const [langPart, stylePart] = parts as [string, string];
    if (
      langPart.startsWith(LANG_PREFIX) &&
      stylePart.startsWith(STYLE_PREFIX) &&
      isLanguageSlug(langPart.slice(LANG_PREFIX.length)) &&
      isStyleSlug(stylePart.slice(STYLE_PREFIX.length))
    ) {
      return { kind: "lang+style", lang: langPart.slice(LANG_PREFIX.length), style: stylePart.slice(STYLE_PREFIX.length) };
    }
  }
  return null;
}

export type PublishedCategory = { key: string; tracks: number };

/**
 * The published categories: known keys only, at least
 * PUBLISHED_MIN_TRACKS chart-eligible tracks (APPROVED, available,
 * voters >= MIN_VOTERS).
 */
export async function publishedCategories(
  seam: { client?: PrismaClient } = {},
): Promise<PublishedCategory[]> {
  const client = seam.client ?? defaultDb;
  const counts = await client.trackScore.groupBy({
    by: ["categoryKey"],
    where: { voters: { gte: MIN_VOTERS }, track: { status: "APPROVED", available: true } },
    _count: { trackId: true },
  });
  return counts
    .filter((row) => parseCategoryKey(row.categoryKey) !== null)
    .filter((row) => row._count.trackId >= PUBLISHED_MIN_TRACKS)
    .map((row) => ({ key: row.categoryKey, tracks: row._count.trackId }))
    .sort((a, b) => b.tracks - a.tracks || a.key.localeCompare(b.key));
}
