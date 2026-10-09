// H-303 static checks: the mechanical comment body pipeline — NFKC
// normalisation, zero-width and control character stripping, 1-500
// characters, and the link rejection table from the done criteria
// (HTTP://, www.x, x.com, full-width forms) — plus the moderator action
// schema (HIDE/REMOVE carry a statement of reasons). No DB involved.

import { describe, expect, it } from "vitest";
import {
  MAX_COMMENT_CHARS,
  moderatorCommentActionSchema,
  normalizeCommentBody,
} from "@/server/comments/service";

const ok = (raw: string): string => {
  const result = normalizeCommentBody(raw);
  expect(result.ok, JSON.stringify(raw)).toBe(true);
  return (result as { ok: true; body: string }).body;
};
const code = (raw: string): string => {
  const result = normalizeCommentBody(raw);
  expect(result.ok, JSON.stringify(raw)).toBe(false);
  return (result as { ok: false; code: string }).code;
};

describe("comment body mechanical rules (H-303)", () => {
  it("accepts plain text in every script and normalises NFKC", () => {
    expect(ok("Просто хороший трек")).toBe("Просто хороший трек");
    expect(ok("  padded  ")).toBe("padded");
    // Full-width letters and colon fold to ASCII and are then caught as links.
    expect(ok("Ｘｙｚ")).toBe("Xyz");
    expect(ok("музыка 幻夢 🎸")).toBe("музыка 幻夢 🎸");
  });

  it("rejects links in every tested spelling", () => {
    expect(code("look: http://x.com")).toBe("LINK_FORBIDDEN");
    expect(code("look: HTTP://X.COM")).toBe("LINK_FORBIDDEN"); // case-insensitive scheme
    expect(code("see www.x.com")).toBe("LINK_FORBIDDEN");
    expect(code("WWW.example.net")).toBe("LINK_FORBIDDEN");
    expect(code("go to x.com now")).toBe("LINK_FORBIDDEN"); // name.tld
    expect(code("read example.ru/post")).toBe("LINK_FORBIDDEN");
    // Full-width forms: NFKC folds them first, the link check then matches.
    expect(code("ｈｔｔｐ：//example.com")).toBe("LINK_FORBIDDEN");
    // Zero-width characters cannot hide a link.
    expect(code("h\u200Bttp://x.com")).toBe("LINK_FORBIDDEN");
    expect(code("ww\u2060w.x.com")).toBe("LINK_FORBIDDEN");
    expect(code("x\uFEFF.com")).toBe("LINK_FORBIDDEN");
  });

  it("documents the false-positive trade-off: unlisted TLDs pass", () => {
    expect(ok("my favourite genre is lo-fi.house")).toBe("my favourite genre is lo-fi.house");
    expect(ok("the file track.mp3 is fine")).toBe("the file track.mp3 is fine");
  });

  it("strips zero-width and control characters, then applies the length rule", () => {
    expect(ok("hi\u0000there\u200B")).toBe("hithere");
    expect(ok("a\u2060b")).toBe("ab");
    expect(code("\u0000\u200B")).toBe("EMPTY_BODY"); // nothing survives stripping
    expect(code("a".repeat(MAX_COMMENT_CHARS + 1))).toBe("BODY_TOO_LONG");
    expect(ok("a".repeat(MAX_COMMENT_CHARS))).toHaveLength(MAX_COMMENT_CHARS);
  });

  it("requires a statement of reasons for HIDE and REMOVE, not for APPROVE", () => {
    expect(moderatorCommentActionSchema.safeParse({ action: "APPROVE" }).success).toBe(true);
    expect(moderatorCommentActionSchema.safeParse({ action: "HIDE" }).success).toBe(false);
    expect(moderatorCommentActionSchema.safeParse({ action: "REMOVE" }).success).toBe(false);
    expect(moderatorCommentActionSchema.safeParse({ action: "HIDE", reason: "off-topic spam" }).success).toBe(true);
    expect(moderatorCommentActionSchema.safeParse({ action: "REMOVE", reason: "abuse" }).success).toBe(true);
  });
});
