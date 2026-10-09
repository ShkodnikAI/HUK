// Moderator decisions on the moderation queue (H-207): approve, reject
// (with a mandatory statement of reasons) and restrict by country. Every
// action is role-guarded upstream (requireRole in the route), writes an
// AuditLog row with the actor, and keeps the paper trail:
//   - approve/reject append a ModerationRun(HUMAN, …) row;
//   - reject stores the statement of reasons as a resolved Report on the
//     track, so the author sees it through GET /api/tracks/mine (the
//     H-203/H-206 visibility plumbing — no new reader).
// H-402 adds SET_TERMS: a metadata correction (not a moderation verdict) —
// replaces the track's confirmed taxonomy terms from the controlled
// vocabulary, on any status, audited.

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { isDirectionSlug, isStyleSlug, languageTermSlug } from "@/server/taxonomy/vocabulary";
import { replaceConfirmedTerms, type TermRef } from "@/server/taxonomy/store";
import type { User } from "@prisma/client";

const BCP47 = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

export const moderatorActionSchema = z
  .object({
    trackId: z.string().min(1).max(64),
    action: z.enum(["APPROVE", "REJECT", "RESTRICT", "SET_TERMS"]),
    reason: z
      .string()
      .transform((s) => s.normalize("NFC").trim())
      .refine((s) => s.length >= 1 && s.length <= 2000, "reason must be 1-2000 characters")
      .optional(),
    countryCode: z
      .string()
      .regex(/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2")
      .optional(),
    terms: z
      .object({
        language: z.string().regex(BCP47, "language must be a BCP-47 tag").optional(),
        style: z.string().max(64).optional(),
        direction: z.string().max(64).optional(),
      })
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "REJECT" && !v.reason) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is required for REJECT" });
    }
    if (v.action === "RESTRICT") {
      if (!v.countryCode) {
        ctx.addIssue({ code: "custom", path: ["countryCode"], message: "countryCode is required for RESTRICT" });
      }
      if (!v.reason) {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is required for RESTRICT" });
      }
    }
    if (v.action === "SET_TERMS") {
      if (!v.terms) {
        ctx.addIssue({ code: "custom", path: ["terms"], message: "terms are required for SET_TERMS" });
        return;
      }
      const { language, style, direction } = v.terms;
      if (language === undefined && style === undefined && direction === undefined) {
        ctx.addIssue({ code: "custom", path: ["terms"], message: "at least one of language, style, direction is required" });
      }
      if (style !== undefined && !isStyleSlug(style)) {
        ctx.addIssue({ code: "custom", path: ["terms", "style"], message: "style must be a slug from the controlled vocabulary" });
      }
      if (direction !== undefined && !isDirectionSlug(direction)) {
        ctx.addIssue({ code: "custom", path: ["terms", "direction"], message: "direction must be a slug from the controlled vocabulary" });
      }
    }
  });

export type ModeratorActionInput = z.infer<typeof moderatorActionSchema>;

export type ModeratorActionSeam = {
  client?: typeof defaultDb;
  now?: () => Date;
};

export async function moderatorTrackAction(
  input: ModeratorActionInput,
  actor: User,
  seam: ModeratorActionSeam = {},
): Promise<{ status: string }> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const track = await client.track.findUnique({ where: { id: input.trackId }, select: { id: true, status: true, instrumental: true } });
  if (!track) {
    throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${input.trackId}`);
  }

  // H-402 SET_TERMS: a metadata correction, not a moderation verdict —
  // allowed on every status, never touches the moderation pipeline.
  if (input.action === "SET_TERMS") {
    const terms = input.terms!;
    const refs: TermRef[] = [];
    let language = track.instrumental ? null : terms.language ?? null;
    if (terms.language !== undefined && !track.instrumental) {
      refs.push({ kind: "LANGUAGE", slug: languageTermSlug(terms.language) });
    }
    if (terms.direction !== undefined) {
      refs.push({ kind: "DIRECTION", slug: terms.direction });
    }
    if (terms.style !== undefined) {
      refs.push({ kind: "STYLE", slug: terms.style });
    }
    await client.$transaction(async (tx) => {
      if (terms.language !== undefined && !track.instrumental) {
        await tx.track.update({ where: { id: track.id }, data: { language: terms.language } });
      }
      await replaceConfirmedTerms(tx, track.id, refs);
    });
    await audit({
      actorId: actor.id,
      actorKind: "user",
      action: "track.terms-updated",
      targetType: "Track",
      targetId: track.id,
      payload: {
        language: language,
        style: terms.style ?? null,
        direction: terms.direction ?? null,
      },
    });
    return { status: track.status };
  }

  if (track.status !== "PENDING") {
    throw new HttpError(409, "NOT_PENDING", `track ${input.trackId} is ${track.status}, only PENDING tracks are decidable`);
  }

  if (input.action === "APPROVE") {
    await client.track.update({
      where: { id: track.id },
      data: { status: "APPROVED", moderatedBy: actor.id, moderatedAt: now() },
    });
    await client.moderationRun.create({
      data: {
        trackId: track.id,
        stage: "HUMAN",
        verdict: "APPROVE",
        payload: { note: "moderator decision", actorId: actor.id, reason: input.reason ?? null },
      },
    });
    await audit({
      actorId: actor.id,
      actorKind: "user",
      action: "track.moderator-approved",
      targetType: "Track",
      targetId: track.id,
      payload: { reason: input.reason ?? null },
    });
    return { status: "APPROVED" };
  }

  if (input.action === "REJECT") {
    await client.track.update({
      where: { id: track.id },
      data: { status: "REJECTED", moderatedBy: actor.id, moderatedAt: now(), aiSummary: input.reason ?? null },
    });
    await client.moderationRun.create({
      data: {
        trackId: track.id,
        stage: "HUMAN",
        verdict: "REJECT",
        payload: { note: "moderator decision", actorId: actor.id, reason: input.reason },
      },
    });
    // Statement of reasons for the author: stored as a resolved report so
    // GET /api/tracks/mine surfaces it (existing plumbing, no new reader).
    await client.report.create({
      data: {
        targetType: "TRACK",
        targetId: track.id,
        reporterId: null,
        reason: "moderator decision",
        category: "MODERATOR",
        urgency: 0,
        status: "ACTIONED",
        resolution: input.reason,
        resolvedById: actor.id,
        resolvedAt: now(),
      },
    });
    await audit({
      actorId: actor.id,
      actorKind: "user",
      action: "track.moderator-rejected",
      targetType: "Track",
      targetId: track.id,
      payload: { reason: input.reason },
    });
    return { status: "REJECTED" };
  }

  // RESTRICT: same record shape as the H-206 report path (upsert + audit).
  await client.track.update({ where: { id: track.id }, data: { moderatedBy: actor.id, moderatedAt: now() } });
  await client.regionRestriction.upsert({
    where: { trackId_countryCode: { trackId: track.id, countryCode: input.countryCode! } },
    create: { trackId: track.id, countryCode: input.countryCode!, reason: input.reason! },
    update: { reason: input.reason! },
  });
  await audit({
    actorId: actor.id,
    actorKind: "user",
    action: "track.region-restricted",
    targetType: "Track",
    targetId: track.id,
    payload: { countryCode: input.countryCode, reason: input.reason },
  });
  return { status: "PENDING" };
}
