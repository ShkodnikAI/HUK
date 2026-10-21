// Account export and deletion (H-214, S7; completeness H-308): the caller's
// own data in one JSON document, and the erase-on-request path. Deletion
// anonymises the user (email → deleted-<id>@invalid.local, name and image
// cleared, deletedAt set, role LISTENER), deletes sessions, accounts and
// verification tokens, playlists, reactions and comment authorship (the
// text replaced by a placeholder), the artist profile, EVERY row still
// keyed to the user in ListenEvent, ListenSession and VoteFlag, the invites
// they created (createdById is NOT NULL — they cannot be kept keyless),
// nulls the invite they redeemed (usedById) and the report contact
// (reporterId/reporterContact → null; the report itself survives for
// moderation); every own track goes through takedownTrack
// ("author-withdrew", H-206/H-212), and the artist's own lyrics are nulled
// on every own track — all statuses — in the same erasure transaction
// (H-311: personal creative text does not outlive the account). Consent
// rows are kept — they prove what was accepted and hold only the user id,
// no raw IP. AuditLog keeps account.deleted with the user id only, never
// the email.
//
// Scores: removing reactions AND listen events changes the affected
// tracks' scores — their TrackScore rows are dropped in the same
// transaction, so the next ranking pass (H-304, within ~10 minutes of the
// worker running) recomputes them from the remaining signals. Say so
// wherever the deletion is documented.

import { z } from "zod";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { takedownTrack } from "@/server/tracks/takedown";
import type { PrismaClient, User } from "@prisma/client";

/** H-214: the export door answers at most 3 times per day per user. */
export const EXPORT_RATE_LIMIT = { limit: 3, windowSec: 24 * 60 * 60 } as const;

export const deleteAccountSchema = z.object({
  confirmEmail: z.string().min(3).max(200),
});

export type AccountSeam = {
  client?: PrismaClient;
  now?: () => Date;
};

/** The listen-event retention window (S7) — raw rows still inside it are exported. */
const LISTEN_EVENT_RETENTION_DAYS = 90; // RETENTION_LISTEN_EVENTS_DAYS default (env.ts)

/**
 * The caller's own data, nothing of anybody else's (S7). Listen events are
 * the raw rows still inside the retention window (RETENTION_LISTEN_EVENTS_DAYS).
 */
export async function exportUserData(user: User, seam: AccountSeam = {}): Promise<Record<string, unknown>> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());
  const retentionCutoff = new Date(now().getTime() - LISTEN_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const [artistProfile, tracks, consents, playlists, reactions, comments, listenEvents, listenSessions, voteFlags, reports] = await Promise.all([
    client.artistProfile.findUnique({ where: { userId: user.id } }),
    client.track.findMany({
      where: { artist: { userId: user.id } },
      include: {
        source: { select: { provider: true, url: true, externalId: true } },
        terms: { where: { confirmed: true }, include: { term: { select: { kind: true, slug: true } } } },
      },
      orderBy: { createdAt: "asc" },
    }),
    client.consent.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    client.playlist.findMany({
      where: { ownerId: user.id },
      include: { items: { select: { trackId: true, addedAt: true }, orderBy: { addedAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    client.reaction.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    client.comment.findMany({ where: { authorId: user.id }, orderBy: { createdAt: "asc" } }),
    client.listenEvent.findMany({
      where: { userId: user.id, createdAt: { gte: retentionCutoff } },
      orderBy: { createdAt: "asc" },
    }),
    // H-308 (export parity): every table that holds rows of this user is
    // exported — the listen sessions, the vote flags and the reporter
    // contact are part of the person's data. AuditLog is intentionally
    // absent (user id only, internal accountability); Consent rows are
    // exported below; both stay after erasure by design.
    client.listenSession.findMany({ where: { userId: user.id }, orderBy: { startedAt: "asc" } }),
    client.voteFlag.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    client.report.findMany({ where: { reporterId: user.id }, orderBy: { createdAt: "asc" } }),
  ]);

  return {
    exportedAt: now().toISOString(),
    profile: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: user.image,
      role: user.role,
      locale: user.locale,
      emailVerified: user.emailVerified?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    },
    artistProfile: artistProfile
      ? {
          handle: artistProfile.handle,
          displayName: artistProfile.displayName,
          bio: artistProfile.bio,
          links: artistProfile.links,
          createdAt: artistProfile.createdAt.toISOString(),
        }
      : null,
    tracks: tracks.map((track) => ({
      id: track.id,
      title: track.title,
      status: track.status,
      language: track.language,
      instrumental: track.instrumental,
      // H-311: the artist's own lyrics are part of their data — exported
      // per track id, exactly as stored (null for instrumentals).
      lyrics: track.lyrics,
      durationSec: track.durationSec,
      licenseScope: track.licenseScope,
      declarations: {
        aiGenerated: track.aiGenerated,
        aiTool: track.aiTool,
        aiPlanAtCreation: track.aiPlanAtCreation,
        humanContribution: track.humanContribution,
        rightsDeclaredAt: track.rightsDeclaredAt?.toISOString() ?? null,
      },
      terms: track.terms.map((t) => ({ kind: t.term.kind, slug: t.term.slug })),
      source: track.source ? { provider: track.source.provider, url: track.source.url, externalId: track.source.externalId } : null,
      createdAt: track.createdAt.toISOString(),
      updatedAt: track.updatedAt.toISOString(),
    })),
    consents: consents.map((c) => ({ document: c.document, version: c.version, createdAt: c.createdAt.toISOString() })),
    playlists: playlists.map((p) => ({
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      createdAt: p.createdAt.toISOString(),
      items: p.items.map((item) => ({ trackId: item.trackId, addedAt: item.addedAt.toISOString() })),
    })),
    reactions: reactions.map((r) => ({ trackId: r.trackId, type: r.type, createdAt: r.createdAt.toISOString() })),
    comments: comments.map((c) => ({
      id: c.id,
      trackId: c.trackId,
      parentId: c.parentId,
      body: c.body,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
    })),
    listenEvents: listenEvents.map((e) => ({
      trackId: e.trackId,
      mode: e.mode,
      msListened: e.msListened,
      completed: e.completed,
      skippedEarly: e.skippedEarly,
      createdAt: e.createdAt.toISOString(),
    })),
    // H-308: closed listen sessions are purged after 48 h (H-210) and raw
    // listen events after the retention window — the export covers whatever
    // still exists; what is gone was already deleted by retention.
    listenSessions: listenSessions.map((s) => ({
      trackId: s.trackId,
      mode: s.mode,
      msListened: s.verifiedMs,
      completed: s.completed,
      startedAt: s.startedAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
    })),
    voteFlags: voteFlags.map((f) => ({
      trackId: f.trackId,
      reason: f.reason,
      createdAt: f.createdAt.toISOString(),
    })),
    reports: reports.map((r) => ({
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      reporterContact: r.reporterContact,
      reason: r.reason,
      category: r.category,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/** The placeholder replaces a deleted user's comment text (H-303 convention). */
const ANONYMISED_COMMENT_BODY = "[removed]";

/**
 * Erases the account. The takedowns run first (each atomic, with the
 * H-212 retire-from-air inside), then the single erasure transaction:
 * sessions, accounts, verification tokens, playlists, reactions, comment
 * authorship (authorId null, text placeholder), the artist profile, every
 * ListenEvent / ListenSession / VoteFlag row of the user, the invites they
 * created (deleted — createdById is NOT NULL) and the invite they redeemed
 * (usedById → null), the report contact (reporterId/reporterContact →
 * null; the report stays for moderation), and the anonymisation of the
 * user row itself. The artist's own lyrics are nulled on every own track
 * (all statuses) inside the same transaction, before the profile is
 * deleted (H-311, S7). Consent rows are kept (by design, no raw IP).
 * Score rows of every track whose signals change (reactions, listen
 * events, own tracks) are dropped so the next ranking pass recomputes
 * them (H-304/H-305/H-307).
 */
export async function deleteAccount(
  user: User,
  input: { confirmEmail: string },
  seam: AccountSeam = {},
): Promise<{ deleted: boolean; scoresNote: string }> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  if (input.confirmEmail.trim() !== user.email) {
    throw new HttpError(403, "CONFIRM_EMAIL_MISMATCH", "confirmEmail does not match the account email");
  }

  const profile = await client.artistProfile.findUnique({
    where: { userId: user.id },
    select: { id: true, tracks: { select: { id: true, status: true } } },
  });
  const ownTrackIds = profile ? profile.tracks.map((t) => t.id) : [];
  const tracksToTakeDown = profile ? profile.tracks.filter((t) => t.status !== "TAKEN_DOWN").map((t) => t.id) : [];

  // 1) The tracks leave the air first (each takedown is atomic and retires
  //    the slots, H-212); a crash here leaves the account intact and retryable.
  for (const trackId of tracksToTakeDown) {
    await takedownTrack(trackId, "author-withdrew", user.id, { client });
  }

  // 2) The erasure transaction: everything the card lists, atomically.
  const reactedTrackIds = (
    await client.reaction.findMany({ where: { userId: user.id }, select: { trackId: true } })
  ).map((r) => r.trackId);
  // H-308: deleting listen events changes scores too — those tracks join
  // the same TrackScore drop (task 4).
  const listenedTrackIds = (
    await client.listenEvent.findMany({ where: { userId: user.id }, select: { trackId: true }, distinct: ["trackId"] })
  ).map((r) => r.trackId);
  await client.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { userId: user.id } });
    await tx.account.deleteMany({ where: { userId: user.id } });
    await tx.verificationToken.deleteMany({ where: { identifier: user.email } });
    await tx.playlist.deleteMany({ where: { ownerId: user.id } });
    await tx.reaction.deleteMany({ where: { userId: user.id } });
    // H-308 (task 1): every remaining row keyed to the user goes away —
    // raw listening, open/closed sessions, anti-fraud vote flags.
    await tx.listenEvent.deleteMany({ where: { userId: user.id } });
    await tx.listenSession.deleteMany({ where: { userId: user.id } });
    await tx.voteFlag.deleteMany({ where: { userId: user.id } });
    // H-308: the reports survive moderation, keyless and contactless
    // (the FK would only fire on user DELETE, but the row is anonymised,
    // never deleted — so both columns are nulled explicitly).
    await tx.report.updateMany({
      where: { reporterId: user.id },
      data: { reporterId: null, reporterContact: null },
    });
    // H-308, invite decision: invites the user CREATED are deleted —
    // createdById is NOT NULL, so nulling would weaken the constraint, and
    // the code hash of an erased account's invite is worthless operational
    // data. The invite they REDEEMED survives with usedById = NULL (it
    // carries no personal data once the user is anonymised).
    await tx.artistInvite.deleteMany({ where: { createdById: user.id } });
    await tx.artistInvite.updateMany({ where: { usedById: user.id }, data: { usedById: null } });
    await tx.comment.updateMany({
      where: { authorId: user.id },
      data: { authorId: null, body: ANONYMISED_COMMENT_BODY },
    });
    // H-311 (S7): the artist's own lyrics are personal creative text —
    // nulled on EVERY own track, all statuses (a track already TAKEN_DOWN
    // by moderation keeps nothing of the author either), inside the same
    // erasure transaction, while the profile relation still resolves the
    // set (the profile deletion below SetNulls the tracks' artistId).
    await tx.track.updateMany({
      where: { artist: { userId: user.id } },
      data: { lyrics: null },
    });
    if (profile) {
      await tx.artistProfile.delete({ where: { id: profile.id } }); // the tracks' artistId falls to SetNull
    }
    // Scores that the removed reactions, listen events and the takedowns
    // invalidate: dropped here, recomputed by the next ranking pass.
    const affected = [...new Set([...reactedTrackIds, ...listenedTrackIds, ...ownTrackIds])];
    if (affected.length > 0) {
      await tx.trackScore.deleteMany({ where: { trackId: { in: affected } } });
    }
    await tx.user.update({
      where: { id: user.id },
      data: {
        email: `deleted-${user.id}@invalid.local`,
        name: null,
        image: null,
        role: "LISTENER",
        emailVerified: null,
        reputation: 1.0,
        deletedAt: now(),
      },
    });
  });

  // 3) The audit row: the user id only, never the email (S7).
  await audit({
    actorId: user.id,
    actorKind: "user",
    action: "account.deleted",
    targetType: "User",
    targetId: user.id,
    payload: { takenDownTracks: tracksToTakeDown.length },
  });

  return {
    deleted: true,
    scoresNote:
      "Scores affected by the removed reactions and listen events are recomputed by the next ranking pass (H-304); charts and the air refill from the remaining signals.",
  };
}
