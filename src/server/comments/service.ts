// Comments (H-303, ARCHITECTURE §7): signed-in listeners comment on an
// APPROVED, available track after at least 30 s of server-verified
// listening on that track within the last 24 h (H-301 gate); accounts
// younger than 24 h cannot comment. Bodies are untrusted text (S5):
// NFKC-normalised, zero-width and control characters stripped, 1-500
// characters, no links — a case-insensitive scheme, a `www.` prefix, and
// a conservative common-TLD `name.tld` pattern (false-positive trade-off:
// a benign word that ends in a listed TLD is rejected too; the list is
// kept short on purpose, and NFKC already folds full-width spellings).
//
// Publication is held-by-default (Owner decision 2026-10-08, option (a)):
// every new comment is HELD and becomes VISIBLE only through a moderator
// action. Until H-208 the text check is a stub, so nothing may publish
// automatically (S9: fail closed). One level of replies. The author can
// edit within 10 minutes (an edit re-holds the comment) and delete their
// own comment (REMOVED, body replaced by a placeholder — the DB check
// keeps char_length(body) >= 1). The track's artist can hide a comment
// under their own track. Every moderator decision carries a statement of
// reasons that reaches the commenter through their own-comments view.
//
// Ticker readiness (Auditor note 2026-10-09): the station-wide "latest N
// approved comments with track title" query is
//   db.comment.findMany({ where: { status: "VISIBLE" },
//     orderBy: { createdAt: "desc" }, take: N,
//     include: { track: { select: { title: true } } } })
// — a follow-up naryad can expose it as a cacheable read route and add a
// (status, createdAt) index when the ticker ships.

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { VERIFIED_FOR_REACTION_MS } from "@/server/listen/session";
import type { User } from "@prisma/client";

export const MAX_COMMENT_CHARS = 500;
/** Raw input upper bound before normalisation (the DB column caps at 2000). */
export const MAX_RAW_COMMENT_CHARS = 2000;
export const MIN_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;
export const COMMENT_EDIT_WINDOW_MS = 10 * 60 * 1000;
/** The DB check keeps char_length(body) BETWEEN 1 AND 2000 — a removed body becomes this placeholder. */
export const REMOVED_BODY_PLACEHOLDER = "[removed]";

const ZERO_WIDTH = /[\u200B-\u200F\u2060-\u2064\uFEFF]/g;
const CONTROL = /\p{Cc}/gu;
/** `scheme://` — case-insensitive; NFKC has already folded full-width spellings. */
const LINK_SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;
const LINK_WWW = /\bwww\./i;
/**
 * Conservative `name.tld` list (H-303): common generic and country TLDs
 * only. Trade-off documented: benign tokens like `lo-fi.house` pass, while
 * anything that looks like `x.com` is rejected — links are simply not
 * worth the risk while no semantic check exists.
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

export type NormalizedBody =
  | { ok: true; body: string }
  | { ok: false; code: "EMPTY_BODY" | "BODY_TOO_LONG" | "LINK_FORBIDDEN" };

/**
 * The mechanical pipeline: NFKC → strip zero-width and control characters
 * → trim → length and link checks. Pure, unit-tested against the table in
 * the done criteria (HTTP://, www.x, x.com, full-width forms, hidden
 * zero-width spellings, 501 characters).
 */
export function normalizeCommentBody(raw: string): NormalizedBody {
  const normalized = raw
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(CONTROL, "")
    .trim();
  if (normalized.length === 0) return { ok: false, code: "EMPTY_BODY" };
  if (normalized.length > MAX_COMMENT_CHARS) return { ok: false, code: "BODY_TOO_LONG" };
  if (LINK_SCHEME.test(normalized) || LINK_WWW.test(normalized) || LINK_NAME_TLD.test(normalized)) {
    return { ok: false, code: "LINK_FORBIDDEN" };
  }
  return { ok: true, body: normalized };
}

/** 422 with a typed code for a rejected body. */
function bodyError(result: Exclude<NormalizedBody, { ok: true }>): HttpError {
  const message = result.code === "LINK_FORBIDDEN"
    ? "comments cannot contain links"
    : result.code === "BODY_TOO_LONG"
      ? `comment body must be 1-${MAX_COMMENT_CHARS} characters`
      : "comment body must not be empty";
  return new HttpError(422, result.code, message);
}

export const createCommentSchema = z.object({
  body: z.string().min(1).max(MAX_RAW_COMMENT_CHARS),
  parentId: z.string().min(1).max(64).optional(),
});

export const editCommentSchema = z.object({
  body: z.string().min(1).max(MAX_RAW_COMMENT_CHARS),
});

export const moderatorCommentActionSchema = z
  .object({
    action: z.enum(["APPROVE", "HIDE", "REMOVE"]),
    reason: z
      .string()
      .transform((s) => s.normalize("NFC").trim())
      .refine((s) => s.length >= 1 && s.length <= 2000, "reason must be 1-2000 characters")
      .optional(),
  })
  .superRefine((v, ctx) => {
    // HIDE and REMOVE both carry a statement of reasons (card task 4);
    // it reaches the commenter through their own-comments view.
    if ((v.action === "HIDE" || v.action === "REMOVE") && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: `reason is required for ${v.action}` });
    }
  });

export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export type ModeratorCommentInput = z.infer<typeof moderatorCommentActionSchema>;

export type CommentsSeam = {
  client?: typeof defaultDb;
  now?: () => Date;
};

/** The 24 h account-age + 30 s verified-listening gate (H-301 numbers). */
export async function assertCanComment(
  user: Pick<User, "id" | "createdAt">,
  trackId: string,
  seam: CommentsSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());
  if (now().getTime() - user.createdAt.getTime() < MIN_ACCOUNT_AGE_MS) {
    throw new HttpError(403, "ACCOUNT_TOO_NEW", "accounts younger than 24 h cannot comment");
  }
  const eligible = await client.listenSession.findFirst({
    where: {
      userId: user.id,
      trackId,
      verifiedMs: { gte: VERIFIED_FOR_REACTION_MS },
      startedAt: { gte: new Date(now().getTime() - 24 * 60 * 60 * 1000) },
    },
    select: { id: true },
  });
  if (!eligible) {
    throw new HttpError(403, "LISTEN_NOT_VERIFIED", "30 s of verified listening on this track is required before commenting");
  }
}

/** Creates a HELD comment — never auto-published (Owner decision option (a)). */
export async function createComment(
  trackId: string,
  input: CreateCommentInput,
  user: User,
  seam: CommentsSeam = {},
): Promise<{ commentId: string; status: "HELD" }> {
  const client = seam.client ?? defaultDb;

  const body = normalizeCommentBody(input.body);
  if (!body.ok) throw bodyError(body);

  // S2 (fail closed): threads exist only on live, approved content.
  const track = await client.track.findUnique({
    where: { id: trackId },
    select: { id: true, status: true, available: true },
  });
  if (!track) throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${trackId}`);
  if (track.status !== "APPROVED" || !track.available) {
    throw new HttpError(403, "TRACK_NOT_COMMENTABLE", "comments exist only on approved, available tracks");
  }

  if (input.parentId) {
    const parent = await client.comment.findUnique({ where: { id: input.parentId }, select: { trackId: true, parentId: true, status: true } });
    if (!parent || parent.trackId !== trackId) {
      throw new HttpError(422, "PARENT_INVALID", "the parent comment must belong to the same track");
    }
    if (parent.parentId !== null) {
      throw new HttpError(422, "PARENT_DEPTH", "replies to replies are not allowed (one level of replies)");
    }
    if (parent.status !== "VISIBLE") {
      throw new HttpError(422, "PARENT_NOT_VISIBLE", "replies attach only to visible comments");
    }
  }

  const created = await client.comment.create({
    data: {
      trackId,
      authorId: user.id,
      parentId: input.parentId ?? null,
      body: body.body,
      status: "HELD",
    },
    select: { id: true },
  });
  return { commentId: created.id, status: "HELD" };
}

export type CommentView = {
  id: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  mine: boolean;
  /** Own HELD row: the "waiting for review" flag (card task 3). */
  waitingForReview?: boolean;
  /** Own moderated rows: the moderator's statement of reasons (audit trail). */
  statementOfReasons?: string | null;
};

/**
 * Public thread read (newest first, cursor pagination). Only VISIBLE rows
 * are public; the author additionally sees their own HELD rows with the
 * "waiting for review" flag and their own HIDDEN/REMOVED rows with the
 * moderator's statement of reasons — the audit payload is the single
 * store, no new table.
 */
export async function listComments(
  trackId: string,
  viewer: { id: string } | null,
  cursor: Date | null,
  limit: number,
  seam: CommentsSeam = {},
): Promise<{ comments: CommentView[]; nextCursor: string | null }> {
  const client = seam.client ?? defaultDb;
  const rows = await client.comment.findMany({
    where: {
      trackId,
      createdAt: cursor ? { lt: cursor } : undefined,
      OR: [{ status: "VISIBLE" }, ...(viewer ? [{ authorId: viewer.id }] : [])],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: { id: true, parentId: true, body: true, status: true, createdAt: true, authorId: true },
  });

  const statementOfReasons = new Map<string, string | null>();
  const moderatedOwn = rows.filter((r) => viewer && r.authorId === viewer.id && (r.status === "HIDDEN" || r.status === "REMOVED"));
  if (moderatedOwn.length > 0) {
    const auditRows = await client.auditLog.findMany({
      where: { targetType: "Comment", targetId: { in: moderatedOwn.map((r) => r.id) }, action: "comment.moderator-action" },
      orderBy: { createdAt: "desc" },
      select: { targetId: true, payload: true },
    });
    for (const row of auditRows) {
      if (row.targetId === null || statementOfReasons.has(row.targetId)) continue; // keep the latest decision only
      const reason = (row.payload as { reason?: unknown })?.reason;
      statementOfReasons.set(row.targetId, typeof reason === "string" ? reason : null);
    }
  }

  const page = rows.slice(0, limit);
  const comments: CommentView[] = page.map((r) => {
    const mine = viewer !== null && r.authorId === viewer.id;
    return {
      id: r.id,
      parentId: r.parentId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      mine,
      ...(mine && r.status === "HELD" ? { waitingForReview: true } : {}),
      ...(mine && (r.status === "HIDDEN" || r.status === "REMOVED")
        ? { statementOfReasons: statementOfReasons.get(r.id) ?? null }
        : {}),
    };
  });
  const nextCursor = rows.length > limit ? page.at(-1)!.createdAt.toISOString() : null;
  return { comments, nextCursor };
}

/** The commenter edits within 10 minutes; an edit re-holds the comment (option (a)). */
export async function editOwnComment(
  commentId: string,
  input: { body: string },
  user: Pick<User, "id">,
  seam: CommentsSeam = {},
): Promise<{ status: "HELD" }> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const comment = await client.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new HttpError(404, "COMMENT_NOT_FOUND", `no comment ${commentId}`);
  if (comment.authorId !== user.id) {
    throw new HttpError(403, "NOT_AUTHOR", "only the commenter may edit their comment");
  }
  if (comment.status === "REMOVED" || comment.status === "HIDDEN") {
    throw new HttpError(409, "COMMENT_MODERATED", "a hidden or removed comment cannot be edited");
  }
  if (now().getTime() - comment.createdAt.getTime() > COMMENT_EDIT_WINDOW_MS) {
    throw new HttpError(403, "EDIT_WINDOW_EXPIRED", "comments can be edited for 10 minutes after posting");
  }
  const body = normalizeCommentBody(input.body);
  if (!body.ok) throw bodyError(body);
  await client.comment.update({
    where: { id: comment.id },
    data: { body: body.body, status: "HELD" },
  });
  return { status: "HELD" };
}

/** The commenter deletes their own comment: REMOVED, body placeholder (audited). */
export async function deleteOwnComment(
  commentId: string,
  user: Pick<User, "id">,
  seam: CommentsSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  const comment = await client.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new HttpError(404, "COMMENT_NOT_FOUND", `no comment ${commentId}`);
  if (comment.authorId !== user.id) {
    throw new HttpError(403, "NOT_AUTHOR", "only the commenter may delete their comment");
  }
  if (comment.status === "REMOVED") return; // idempotent
  await client.comment.update({
    where: { id: comment.id },
    data: { status: "REMOVED", body: REMOVED_BODY_PLACEHOLDER },
  });
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "comment.deleted-by-author",
    targetType: "Comment",
    targetId: comment.id,
    payload: { trackId: comment.trackId },
  });
}

/** The track's artist hides a comment under their own track (audited). */
export async function hideCommentAsArtist(
  commentId: string,
  artistUserId: string,
  seam: CommentsSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  const comment = await client.comment.findUnique({
    where: { id: commentId },
    include: { track: { include: { artist: { select: { userId: true } } } } },
  });
  if (!comment) throw new HttpError(404, "COMMENT_NOT_FOUND", `no comment ${commentId}`);
  const owner = comment.track.artist?.userId;
  if (owner !== artistUserId) {
    throw new HttpError(403, "NOT_TRACK_ARTIST", "only the track's artist may hide comments under it");
  }
  if (comment.status === "REMOVED") {
    throw new HttpError(409, "COMMENT_REMOVED", "a removed comment cannot change status");
  }
  if (comment.status === "HIDDEN") return; // idempotent
  await client.comment.update({ where: { id: comment.id }, data: { status: "HIDDEN" } });
  await audit({
    actorId: artistUserId,
    actorKind: "user",
    action: "comment.hidden-by-artist",
    targetType: "Comment",
    targetId: comment.id,
    payload: { trackId: comment.trackId },
  });
}

/**
 * Moderator decision: HELD → VISIBLE (APPROVE), → HIDDEN (HIDE, reason
 * recommended but optional), → REMOVED with a mandatory statement of
 * reasons (REMOVE). The decision (with the reason) is audited; the
 * commenter reads the reason through their own-comments view.
 */
export async function moderatorCommentAction(
  commentId: string,
  input: ModeratorCommentInput,
  moderator: Pick<User, "id">,
  seam: CommentsSeam = {},
): Promise<{ status: "VISIBLE" | "HIDDEN" | "REMOVED" }> {
  const client = seam.client ?? defaultDb;
  const comment = await client.comment.findUnique({ where: { id: commentId } });
  if (!comment) throw new HttpError(404, "COMMENT_NOT_FOUND", `no comment ${commentId}`);
  if (comment.status === "REMOVED") {
    throw new HttpError(409, "COMMENT_REMOVED", "a removed comment cannot change status");
  }
  // Fail closed (S9): HIDE and REMOVE always carry a statement of reasons
  // — the route schema enforces it, the service enforces it again.
  if (input.action !== "APPROVE" && !(input.reason && input.reason.trim().length > 0)) {
    throw new HttpError(422, "REASON_REQUIRED", `reason is required for ${input.action}`);
  }
  // APPROVE on a HIDDEN comment is a deliberate re-approval by the moderator.
  const nextStatus = input.action === "APPROVE" ? "VISIBLE" : input.action === "HIDE" ? "HIDDEN" : "REMOVED";
  await client.comment.update({
    where: { id: comment.id },
    data: {
      status: nextStatus,
      ...(input.action === "REMOVE" ? { body: REMOVED_BODY_PLACEHOLDER } : {}),
    },
  });
  await audit({
    actorId: moderator.id,
    actorKind: "user",
    action: "comment.moderator-action",
    targetType: "Comment",
    targetId: comment.id,
    payload: { trackId: comment.trackId, decision: input.action, reason: input.reason ?? null },
  });
  return { status: nextStatus };
}
