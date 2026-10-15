// Lyrics validation and editing (H-123): one shared pipeline for submit
// (POST /api/tracks) and edit (PATCH /api/tracks/[id]/lyrics). Lyrics are
// the artist's own words — untrusted plain text (S5: data, never rendered
// as HTML). The pipeline is deterministic: \r\n → \n, NFC, trim; an empty
// result means "no lyrics" and is stored as NULL. Control characters other
// than newline and tab are rejected (not stripped — silent rewriting would
// hide what the author actually sent). The maximum length comes from the
// validated env LYRICS_MAX_CHARS (default 6000, see .env.example).
//
// Links and addresses are rejected with the same detector the comment
// service uses (H-303: scheme://, www., conservative name.tld) plus the
// address shapes a lyrics card must additionally refuse (@-addresses and
// spelled-out domains like "example dot com"). Detection runs on the
// NFKC-folded view so full-width spellings cannot sneak past — the stored
// text itself stays NFC. The detector here mirrors the H-303 regexes on
// purpose; a parity test (tests/tracks/lyrics.test.ts) pins both to the
// same verdicts so they cannot drift apart silently.

import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import type { Env } from "@/server/env";

export const LYRICS_DEFAULT_MAX_CHARS = 6000;
/**
 * Raw input upper bound before normalisation — a defensive cap for the
 * zod schemas (parseJson already refuses bodies above 32 KB, so a raw
 * lyrics string can never be larger than this anyway).
 */
export const MAX_RAW_LYRICS_CHARS = 32_768;

/** `scheme://` — case-insensitive (H-303). */
const LINK_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const LINK_WWW = /\bwww\./i;
/**
 * Conservative `name.tld` list — the exact COMMON_TLDS of the H-303
 * comment detector (see src/server/comments/service.ts for the documented
 * false-positive trade-off).
 */
const COMMON_TLDS = [
  "com", "net", "org", "info", "biz", "xyz", "online", "site", "app", "dev",
  "io", "co", "me", "tv", "cc", "gg", "ai",
  "ru", "su", "by", "ua", "kz", "de", "fr", "uk", "pl", "cz", "nl",
];
const LINK_NAME_TLD = new RegExp(
  `\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\\.(?:${COMMON_TLDS.join("|")})\\b`,
  "i",
);
/** An @-address: `@` glued between non-space characters (user@host). */
const AT_ADDRESS = /\S@\S/;
/**
 * Spelled-out links the corpus requires: "example dot com" / "пример точка ру"
 * (the spoken form of a domain) — `dot`/`точка` before a known TLD label.
 */
const SPELLING_DOT_TLD = new RegExp(
  `\\b[a-z0-9-]+\\s+(?:dot|точка)\\s+(?:${COMMON_TLDS.join("|")})\\b`,
  "i",
);
/**
 * The spaced-out scheme "h t t p": an `h` at a word boundary, then t-t-p
 * with only spaces/dots between the letters. Word boundaries keep benign
 * words ("the h t t p" aside, ordinary prose has no boundary-h…t…t…p run).
 */
const SPACED_HTTP = /\bh[\s.]*t[\s.]*t[\s.]*p\b/i;

/** Control characters are rejected; newline and tab are the only exceptions. */
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}]/u;
const NEWLINE_OR_TAB = /[\n\t]/;

export type LyricsErrorCode = "LYRICS_TOO_LONG" | "LYRICS_FORBIDDEN_CHARS" | "LYRICS_LINK_FORBIDDEN";

export type NormalizedLyrics =
  | { ok: true; lyrics: string | null }
  | { ok: false; code: LyricsErrorCode };

/** The link detector, factored out so the parity test can call it directly. */
export function containsLink(foldedText: string): boolean {
  return (
    LINK_SCHEME.test(foldedText) ||
    LINK_WWW.test(foldedText) ||
    LINK_NAME_TLD.test(foldedText) ||
    AT_ADDRESS.test(foldedText) ||
    SPELLING_DOT_TLD.test(foldedText) ||
    SPACED_HTTP.test(foldedText)
  );
}

/**
 * The shared pipeline (card task 2). Pure — the API layers turn the typed
 * failure into a 422 with the same code.
 */
export function normalizeLyrics(raw: string | null, maxChars: number): NormalizedLyrics {
  if (raw === null) return { ok: true, lyrics: null };
  const normalized = raw.replace(/\r\n/g, "\n").normalize("NFC").trim();
  if (normalized.length === 0) return { ok: true, lyrics: null };
  for (const ch of normalized) {
    if (NEWLINE_OR_TAB.test(ch)) continue;
    if (FORBIDDEN_CHARS.test(ch)) return { ok: false, code: "LYRICS_FORBIDDEN_CHARS" };
  }
  if (normalized.length > maxChars) return { ok: false, code: "LYRICS_TOO_LONG" };
  // Detection-only fold: NFKC maps full-width spellings (ｈｔｔｐ, ：//) onto
  // their ASCII shapes; the stored lyrics stay NFC.
  if (containsLink(normalized.normalize("NFKC"))) return { ok: false, code: "LYRICS_LINK_FORBIDDEN" };
  return { ok: true, lyrics: normalized };
}

/** 422 with the typed code; the message names the limit when it applies. */
export function lyricsHttpError(code: LyricsErrorCode, maxChars: number): HttpError {
  const message =
    code === "LYRICS_TOO_LONG"
      ? `lyrics must be at most ${maxChars} characters`
      : code === "LYRICS_LINK_FORBIDDEN"
        ? "lyrics cannot contain links or addresses"
        : "lyrics must not contain control characters (newlines are fine)";
  return new HttpError(422, code, message);
}

export type LyricsSeam = {
  client?: typeof defaultDb;
};

export type LyricsEditResult = {
  trackId: string;
  lyrics: string | null;
  lyricsLength: number | null;
};

/**
 * The edit side of card task 3: the track must belong to the caller's
 * artist profile (otherwise 404 — existence is not leaked), the text goes
 * through the shared pipeline, and the audit row carries the length only —
 * never the lyrics text itself.
 */
export async function updateLyrics(
  userId: string,
  trackId: string,
  raw: string | null,
  env: Env,
  seam: LyricsSeam = {},
): Promise<LyricsEditResult> {
  const client = seam.client ?? defaultDb;
  const normalized = normalizeLyrics(raw, env.LYRICS_MAX_CHARS);
  if (!normalized.ok) throw lyricsHttpError(normalized.code, env.LYRICS_MAX_CHARS);

  const track = await client.track.findFirst({
    where: { id: trackId, artist: { is: { userId } } },
    select: { id: true },
  });
  if (!track) {
    throw new HttpError(404, "NOT_FOUND", "track not found");
  }
  await client.track.update({ where: { id: track.id }, data: { lyrics: normalized.lyrics } });
  await audit({
    actorId: userId,
    actorKind: "user",
    action: "track.lyrics.edit",
    targetType: "Track",
    targetId: track.id,
    payload: { lyricsLength: normalized.lyrics === null ? null : normalized.lyrics.length },
  });
  return {
    trackId: track.id,
    lyrics: normalized.lyrics,
    lyricsLength: normalized.lyrics === null ? null : normalized.lyrics.length,
  };
}
