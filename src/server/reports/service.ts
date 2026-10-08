// Reports service (H-206): create (validated, deduplicated per reporter +
// target, triaged, stored OPEN), list for moderators, and resolve with a
// statement of reasons. Actions: dismiss, takedown, restrict by country,
// ban — every ban/restriction is a human decision taken through this API
// with a mandatory reason and an AuditLog row (S9).

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import type { User } from "@prisma/client";
import { currentTriage } from "./triage";
import { takedownTrack } from "@/server/tracks/takedown";

export const reportActionSchema = z.enum(["DISMISS", "TAKEDOWN", "RESTRICT", "BAN"]);
export type ReportAction = z.infer<typeof reportActionSchema>;

const ISO2 = /^[A-Z]{2}$/;

export const resolveSchema = z
  .object({
    reportId: z.string().min(1).max(64),
    action: reportActionSchema,
    // A statement of reasons is mandatory for EVERY action (policy process
    // rule: every removal records one; a ban without a reason is rejected).
    statementOfReasons: z
      .string()
      .transform((s) => s.normalize("NFC").trim())
      .refine((s) => s.length >= 1 && s.length <= 2000, "statementOfReasons must be 1-2000 characters"),
    countryCode: z
      .string()
      .regex(ISO2, "countryCode must be ISO 3166-1 alpha-2")
      .optional(),
    banDays: z.number().int().min(1).max(3650).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "RESTRICT" && !v.countryCode) {
      ctx.addIssue({ code: "custom", path: ["countryCode"], message: "countryCode is required for RESTRICT" });
    }
    if (v.action === "BAN" && v.banDays === undefined) {
      ctx.addIssue({ code: "custom", path: ["banDays"], message: "banDays is required for BAN" });
    }
  });

export type ResolveInput = z.infer<typeof resolveSchema>;

export type ResolveSeam = {
  client?: typeof defaultDb;
  now?: () => Date;
};

/** Creates the report after dedup; triage sets category + urgency. */
export async function createReport(
  input: {
    targetType: "TRACK" | "COMMENT" | "PLAYLIST" | "USER";
    targetId: string;
    reason: string;
    reporterContact?: string | undefined;
  },
  reporterId: string | null,
  seam: { client?: typeof defaultDb } = {},
): Promise<{ reportId: string; deduped: boolean }> {
  const client = seam.client ?? defaultDb;

  // Dedup: the same reporter (signed-in id, or the anonymous contact) may
  // hold only one OPEN report per target.
  const existing = await client.report.findFirst({
    where: {
      targetType: input.targetType,
      targetId: input.targetId,
      status: "OPEN",
      ...(reporterId ? { reporterId } : { reporterContact: input.reporterContact ?? null }),
    },
    select: { id: true },
  });
  if (existing) {
    return { reportId: existing.id, deduped: true };
  }

  const triage = await currentTriage().triage({ reason: input.reason, targetType: input.targetType });
  const report = await client.report.create({
    data: {
      targetType: input.targetType,
      targetId: input.targetId,
      reporterId,
      reporterContact: reporterId ? null : input.reporterContact ?? null,
      reason: input.reason,
      category: triage.category,
      urgency: triage.urgency,
      status: "OPEN",
    },
    select: { id: true },
  });
  await audit({
    actorId: reporterId ?? undefined,
    actorKind: "user",
    action: "report.created",
    targetType: input.targetType,
    targetId: input.targetId,
    payload: { reportId: report.id, category: triage.category, urgency: triage.urgency },
  });
  return { reportId: report.id, deduped: false };
}

/** OPEN reports for the moderator queue, most urgent first. */
export async function listOpenReports(seam: { client?: typeof defaultDb } = {}, take = 100) {
  const client = seam.client ?? defaultDb;
  return client.report.findMany({
    where: { status: "OPEN" },
    orderBy: [{ urgency: "desc" }, { createdAt: "asc" }],
    take,
  });
}

/**
 * Resolves a report with a human decision. The statement of reasons is
 * stored on the report (the author of a taken-down track sees it through
 * GET /api/tracks/mine; it is never exposed to anyone else).
 */
export async function resolveReport(
  input: ResolveInput,
  actor: User,
  seam: ResolveSeam = {},
): Promise<{ status: string }> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const report = await client.report.findUnique({ where: { id: input.reportId } });
  if (!report) {
    throw new HttpError(404, "REPORT_NOT_FOUND", `no report ${input.reportId}`);
  }
  if (report.status === "ACTIONED" || report.status === "DISMISSED") {
    throw new HttpError(409, "ALREADY_RESOLVED", `report ${input.reportId} is already ${report.status}`);
  }

  switch (input.action) {
    case "DISMISS":
      // No platform action; the statement still explains the decision.
      break;
    case "TAKEDOWN": {
      if (report.targetType !== "TRACK") {
        throw new HttpError(422, "ACTION_TARGET_MISMATCH", "TAKEDOWN applies to TRACK reports only");
      }
      await takedownTrack(report.targetId, input.statementOfReasons, actor.id, { client });
      break;
    }
    case "RESTRICT": {
      if (report.targetType !== "TRACK") {
        throw new HttpError(422, "ACTION_TARGET_MISMATCH", "RESTRICT applies to TRACK reports only");
      }
      const track = await client.track.findUnique({ where: { id: report.targetId }, select: { id: true } });
      if (!track) throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${report.targetId}`);
      await client.regionRestriction.upsert({
        where: { trackId_countryCode: { trackId: report.targetId, countryCode: input.countryCode! } },
        create: { trackId: report.targetId, countryCode: input.countryCode!, reason: input.statementOfReasons },
        update: { reason: input.statementOfReasons },
      });
      await audit({
        actorId: actor.id,
        actorKind: "user",
        action: "track.region-restricted",
        targetType: "Track",
        targetId: report.targetId,
        payload: { countryCode: input.countryCode, reason: input.statementOfReasons },
      });
      break;
    }
    case "BAN": {
      if (report.targetType !== "USER") {
        throw new HttpError(422, "ACTION_TARGET_MISMATCH", "BAN applies to USER reports only");
      }
      const target = await client.user.findUnique({ where: { id: report.targetId }, select: { id: true } });
      if (!target) throw new HttpError(404, "USER_NOT_FOUND", `no user ${report.targetId}`);
      const bannedUntil = new Date(now().getTime() + input.banDays! * 24 * 60 * 60 * 1000);
      await client.user.update({ where: { id: target.id }, data: { bannedUntil } });
      await audit({
        actorId: actor.id,
        actorKind: "user",
        action: "user.banned",
        targetType: "User",
        targetId: target.id,
        payload: { bannedUntil, reason: input.statementOfReasons, reportId: report.id },
      });
      break;
    }
  }

  const status = input.action === "DISMISS" ? "DISMISSED" : "ACTIONED";
  await client.report.update({
    where: { id: report.id },
    data: {
      status,
      resolution: input.statementOfReasons,
      resolvedById: actor.id,
      resolvedAt: now(),
    },
  });
  await audit({
    actorId: actor.id,
    actorKind: "user",
    action: "report.resolved",
    targetType: "Report",
    targetId: report.id,
    payload: { action: input.action, resultStatus: status, targetType: report.targetType, targetId: report.targetId },
  });
  return { status };
}
