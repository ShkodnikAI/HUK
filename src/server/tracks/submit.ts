// Track submission service (H-203): declarations, consent rows, atomic
// daily quotas and the invite gate — one transaction, PENDING for
// moderation. Titles accept every script (NFC-normalised); identity comes
// only from the guard; the client never names the uploader.

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { hashIp } from "@/server/iphash";
import type { Env } from "@/server/env";
import { probeDirectUrl } from "@/server/sources/direct-url";
import { resolveAudiusTrack } from "@/server/sources/audius";
import type { SafeLoader, SafeResolver } from "@/server/net/safe-fetch";
import { CURRENT_ARTIST_TERMS_VERSION, CURRENT_TOS_VERSION } from "@/server/legal/versions";

const CONTROL = /[\p{Cc}\p{Cf}]/u;
const BCP47 = /^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/;

export const submissionSchema = z
  .object({
    title: z
      .string()
      .max(400)
      .transform((s) => s.normalize("NFC").trim())
      .refine((s) => s.length >= 1 && s.length <= 200, "title must be 1-200 characters")
      .refine((s) => !CONTROL.test(s), "title must not contain control characters"),
    source: z.discriminatedUnion("provider", [
      z.object({ provider: z.literal("DIRECT_URL"), url: z.string().min(8).max(2048) }),
      z.object({ provider: z.literal("AUDIUS"), externalId: z.string().min(1).max(64) }),
    ]),
    rightsOwned: z.literal(true, { message: "rightsOwned must be literally true" }),
    aiGenerated: z.boolean(),
    aiTool: z.string().max(200).optional(),
    aiPlanAtCreation: z.string().max(2000).optional(),
    humanContribution: z.string().max(500),
    language: z
      .string()
      .regex(BCP47, "language must be a BCP-47 tag")
      .optional(),
    instrumental: z.boolean().default(false),
    licenseScope: z.enum(["RADIO_ONLY", "RADIO_AND_PLAYLISTS"]),
    tosVersion: z.string().max(50),
  })
  .superRefine((v, ctx) => {
    if (v.aiGenerated && (!v.aiTool || v.aiTool.trim() === "" || !v.aiPlanAtCreation || v.aiPlanAtCreation.trim() === "")) {
      ctx.addIssue({ code: "custom", path: ["aiTool"], message: "aiTool and aiPlanAtCreation are required when aiGenerated is true" });
    }
    if (!v.instrumental && !v.language) {
      ctx.addIssue({ code: "custom", path: ["language"], message: "language is required unless instrumental" });
    }
    if (v.tosVersion !== CURRENT_TOS_VERSION) {
      ctx.addIssue({ code: "custom", path: ["tosVersion"], message: `tosVersion must be ${CURRENT_TOS_VERSION}` });
    }
  });

export type SubmissionInput = z.infer<typeof submissionSchema>;

export type SubmitSeam = {
  loader?: SafeLoader;
  resolver?: SafeResolver;
  portAllowlist?: number[];
  client?: typeof defaultDb;
  env?: Env;
};

/** Validates the source through H-202 (network happens outside the tx). */
async function validateSource(
  source: SubmissionInput["source"],
  env: Env,
  seam: SubmitSeam,
): Promise<{ provider: "DIRECT_URL" | "AUDIUS"; url: string; externalId: string | null; etag: string | null; byteLength: bigint | null }> {
  if (source.provider === "DIRECT_URL") {
    try {
      const probe = await probeDirectUrl(source.url, {
        loader: seam.loader,
        resolver: seam.resolver,
        portAllowlist: seam.portAllowlist,
      });
      return { provider: "DIRECT_URL", url: source.url, externalId: null, etag: probe.etag, byteLength: probe.byteLength };
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new HttpError(422, "SOURCE_UNREACHABLE", `source could not be validated: ${detail.slice(0, 200)}`);
    }
  }
  const res = await resolveAudiusTrack(source.externalId, {
    enabled: env.AUDIUS_ENABLED,
    loader: seam.loader,
  });
  return { provider: "AUDIUS", url: res.streamUrl, externalId: res.externalId, etag: null, byteLength: null };
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Creates the submission in one transaction: consent rows (ToS + artist
 * terms, IP only as a rotating salted hash), the PENDING track, the
 * TrackSource. Daily author and platform caps are enforced atomically with
 * pg advisory xact locks (consistent lock order: author, then platform).
 */
export async function submitTrack(
  userId: string,
  ip: string | null,
  input: SubmissionInput,
  env: Env,
  seam: SubmitSeam = {},
): Promise<{ trackId: string }> {
  const client = seam.client ?? defaultDb;
  const now = new Date();
  const source = await validateSource(input.source, env, seam);
  const ipHash = ip ? hashIp(ip, now, env) : null;

  const trackId = await client.$transaction(async (tx) => {
    // The author identity in the catalogue is the ArtistProfile (created at
    // onboarding, H-209); submissions without one are refused.
    const profile = await tx.artistProfile.findUnique({ where: { userId } });
    if (!profile) {
      throw new HttpError(403, "NO_ARTIST_PROFILE", "create an artist profile before submitting");
    }
    // Atomic quota enforcement: serialize per author, then platform-wide.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`author:${userId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('huk:platform-daily-cap'))`;
    const midnight = utcMidnight(now);
    const authorToday = await tx.track.count({ where: { artistId: profile.id, createdAt: { gte: midnight } } });
    if (authorToday >= env.AUTHOR_DAILY_SUBMISSION_CAP) {
      throw new HttpError(429, "QUOTA_EXCEEDED", "author daily submission cap reached");
    }
    const platformToday = await tx.track.count({ where: { createdAt: { gte: midnight } } });
    if (platformToday >= env.PLATFORM_DAILY_SUBMISSION_CAP) {
      throw new HttpError(429, "QUOTA_EXCEEDED", "platform daily submission cap reached");
    }

    // Consent: the ToS and the artist terms, IP as a hash (never raw).
    await tx.consent.createMany({
      data: [
        { userId, document: "tos", version: input.tosVersion, ipHash },
        { userId, document: "artist-terms", version: CURRENT_ARTIST_TERMS_VERSION, ipHash },
      ],
    });

    const track = await tx.track.create({
      data: {
        artistId: profile.id,
        title: input.title,
        status: "PENDING",
        language: input.instrumental ? null : input.language,
        instrumental: input.instrumental,
        aiGenerated: input.aiGenerated,
        aiTool: input.aiGenerated ? input.aiTool : null,
        aiPlanAtCreation: input.aiGenerated ? input.aiPlanAtCreation : null,
        humanContribution: input.humanContribution,
        licenseScope: input.licenseScope,
        rightsDeclaredAt: now,
      },
      select: { id: true },
    });

    await tx.trackSource.create({
      data: {
        trackId: track.id,
        provider: source.provider,
        externalId: source.externalId,
        url: source.url,
        etag: source.etag,
        byteLength: source.byteLength,
      },
    });

    return track.id;
  });

  await audit({
    actorId: userId,
    actorKind: "user",
    action: "tracks.submitted",
    targetType: "Track",
    targetId: trackId,
    payload: { provider: source.provider, licenseScope: input.licenseScope },
  });
  return { trackId };
}
