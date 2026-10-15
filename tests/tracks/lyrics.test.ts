// H-123 task 7: the lyrics validation pipeline — normalisation, limits,
// control characters, and the link/address detector with its corpus
// (at least 30 rejected and 30 accepted samples, including the required
// obfuscations: spaced "h t t p", spelled-out "example dot com" and
// full-width spellings). The detector must also stay verdict-compatible
// with the H-303 comment detector on the shapes both refuse.

import { describe, expect, it } from "vitest";
import {
  LYRICS_DEFAULT_MAX_CHARS,
  containsLink,
  normalizeLyrics,
} from "@/server/tracks/lyrics";
import { normalizeCommentBody } from "@/server/comments/service";

const MAX = LYRICS_DEFAULT_MAX_CHARS;

/** Rejected (positive) corpus — every entry must come back LYRICS_LINK_FORBIDDEN. */
const REJECTED_LINKS: string[] = [
  "http://example.com/song",
  "https://example.com/track.mp3",
  "HTTP://EXAMPLE.COM/A",
  "ftp://files.example.org/a.mp3",
  "https://example.com:8443/x",
  "www.example.com",
  "WWW.Example.Com",
  "listen at www.huk.fm please",
  "example.com",
  "my song lives on example.org now",
  "find it on soundcloud.com/slash/track",
  "t.me/mychannel",
  "vk.com/artistpage",
  "youtube.com/watch?v=1",
  "track also on apple.co/music",
  "write to artist@example.com",
  "MY@MAIL.COM is my address",
  "user@host.io",
  "contact: me@site.ru",
  "user.name+tag@example.co",
  "ping me at huk-fan@example.com ok",
  "example dot com",
  "Example DOT Net",
  "find me dot ru",
  "the page is my name dot com",
  "h t t p://x",
  "h t t p s : / / example.com",
  "h..t..p://short.example",
  "ｈｔｔｐ：／／example.com",
  "ｅｘａｍｐｌｅ．ｃｏｍ",
  "ｗｗｗ.example.com",
  "https:/example.com",
  "text with www.site.xyz inside",
  "site: example.com",
  "https://example.com trailing",
  "домен example.com в тексте",
];

/** Accepted (negative) corpus — plain lyrics in every script. */
const ACCEPTED_LYRICS: string[] = [
  "Verse one, the night is young",
  "И ночь идёт по улицам",
  "The moon above the silent town",
  "We run through the fire and rain",
  "La la la, the summer hums along",
  "Между нами город и свет",
  "Hold on, hold on",
  "Я слышу голос твой во сне",
  "Every road leads somewhere new",
  "the trees talk in the wind",
  "Пусть бежит река",
  "Under the same sky tonight",
  "Guitar strings and rain",
  "Я рисую рассвет",
  "Counting stars until the dawn",
  "Тишина, только ветер поёт",
  "One more chorus, one more night",
  "Heartbeat like a drum",
  "Сердце бьётся в такт",
  "Dancing on the edge of morning",
  "мы поём о главном",
  "Whispers in the hall",
  "Таблички на стенах и мосты",
  "Every heartbeat knows your name",
  "Autumn leaves are falling down",
  "Осенний дождь по крышам",
  "Sing it louder than the storm",
  "The answer lives in you",
  "Мелодия летит над крышей",
  "Só dança, só dança",
  "你好，世界",
  "А-а-а, а-а-а",
  "The chorus repeats twice",
  "Я иду по краю",
  "first line\nsecond line\nthird line",
  "verse with a\ttab inside",
  "   padded with spaces   ",
  "two\r\nlines joined",
];

describe("normalizeLyrics (H-123 task 2)", () => {
  it("normalises: CRLF to LF, NFC, trim", () => {
    const r = normalizeLyrics("  first\r\nline\u0301  \r\n", MAX);
    expect(r).toEqual({ ok: true, lyrics: "first\nliné" });
  });

  it("an empty or whitespace-only text means no lyrics (null)", () => {
    expect(normalizeLyrics("", MAX)).toEqual({ ok: true, lyrics: null });
    expect(normalizeLyrics("   \n \r\n ", MAX)).toEqual({ ok: true, lyrics: null });
  });

  it("an explicit null passes through as no lyrics", () => {
    expect(normalizeLyrics(null, MAX)).toEqual({ ok: true, lyrics: null });
  });

  it("rejects control characters other than newline and tab (Cc and Cf)", () => {
    expect(normalizeLyrics("bad\u0000text", MAX)).toEqual({ ok: false, code: "LYRICS_FORBIDDEN_CHARS" });
    expect(normalizeLyrics("bad\u0007bell", MAX)).toEqual({ ok: false, code: "LYRICS_FORBIDDEN_CHARS" });
    expect(normalizeLyrics("lone\rcarriage", MAX)).toEqual({ ok: false, code: "LYRICS_FORBIDDEN_CHARS" });
    expect(normalizeLyrics("zero\u200Bwidth", MAX)).toEqual({ ok: false, code: "LYRICS_FORBIDDEN_CHARS" });
    expect(normalizeLyrics("rtl\u202Eoverride", MAX)).toEqual({ ok: false, code: "LYRICS_FORBIDDEN_CHARS" });
    // newline and tab stay allowed
    expect(normalizeLyrics("a\nb\tc", MAX).ok).toBe(true);
  });

  it("enforces the configured maximum after normalisation", () => {
    const ok = "a".repeat(MAX);
    expect(normalizeLyrics(ok, MAX)).toEqual({ ok: true, lyrics: ok });
    expect(normalizeLyrics(`${ok}!`, MAX)).toEqual({ ok: false, code: "LYRICS_TOO_LONG" });
    // with a custom (env-driven) cap
    expect(normalizeLyrics("a".repeat(11), 10)).toEqual({ ok: false, code: "LYRICS_TOO_LONG" });
    expect(normalizeLyrics("a".repeat(10), 10).ok).toBe(true);
  });

  it("the corpus: every rejected sample comes back LYRICS_LINK_FORBIDDEN", () => {
    expect(REJECTED_LINKS.length).toBeGreaterThanOrEqual(30);
    for (const sample of REJECTED_LINKS) {
      const r = normalizeLyrics(sample, MAX);
      expect(r, `expected rejection: ${sample}`).toEqual({ ok: false, code: "LYRICS_LINK_FORBIDDEN" });
    }
  });

  it("the corpus: every accepted sample passes", () => {
    expect(ACCEPTED_LYRICS.length).toBeGreaterThanOrEqual(30);
    for (const sample of ACCEPTED_LYRICS) {
      const r = normalizeLyrics(sample, MAX);
      expect(r.ok, `expected acceptance: ${sample}`).toBe(true);
    }
  });
});

describe("the link detector stays verdict-compatible with the H-303 comment detector", () => {
  // The shapes both services refuse: schemes, www., name.tld. The comment
  // detector answers { ok: false, code: "LINK_FORBIDDEN" }; the lyrics
  // detector answers { ok: false, code: "LYRICS_LINK_FORBIDDEN" }.
  // "Artists.Union" (.union is not a listed TLD) is the accepted control —
  // both detectors must leave it alone.
  const shared: Array<[string, boolean]> = [
    ["http://example.com/a", false],
    ["HTTPS://EXAMPLE.COM", false],
    ["see www.example.com now", false],
    ["plain example.com here", false],
    ["xhttps://spoof.example", false],
    ["go to Artists.Union", true],
  ];

  it("agrees on every shared sample", () => {
    for (const [text, expectedOk] of shared) {
      const comment = normalizeCommentBody(text);
      const lyrics = normalizeLyrics(text, MAX);
      expect(comment.ok, `comments verdict for: ${text}`).toBe(expectedOk);
      expect(lyrics.ok, `lyrics verdict for: ${text}`).toBe(expectedOk);
    }
  });

  it("containsLink is the single decision point the pipeline uses", () => {
    expect(containsLink("plain words only")).toBe(false);
    expect(containsLink("catch the https://part")).toBe(true);
  });
});
