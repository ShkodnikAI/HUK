// Artist onboarding service (H-209): invite creation, invite redemption and
// open-path profile creation. Security-critical properties:
// - Only the SHA-256 of an invite code is stored; the plain code is returned
//   exactly once by the creation call and never logged or persisted.
// - Redemption is atomic: the invite is claimed with a conditional
//   updateMany (row lock) inside the same transaction that creates the
//   profile and grants the ARTIST role — 10 concurrent redemptions yield
//   exactly one success; reused/expired/malformed codes are the SAME
//   generic 404 (no oracle, S9).
// - Every grant writes an AuditLog entry.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "@/server/http/errors";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import { checkOnboardingTexts } from "./handle";

export function hashInviteCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

/** A fresh, unguessable invite code: 144 bits of entropy, URL-safe. */
export function generateInviteCode(): string {
  return randomBytes(18).toString("base64url");
}

export type CreatedInvite = { id: string; code: string; expiresAt: Date };

/** ADMIN action: create one or more invites; the plain codes leave here once. */
export async function createInvites(
  createdById: string,
  count: number,
  expiresInDays: number,
  note: string | undefined,
  client = defaultDb,
): Promise<CreatedInvite[]> {
  const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
  const created: CreatedInvite[] = [];
  for (let i = 0; i < count; i++) {
    const code = generateInviteCode();
    const row = await client.artistInvite.create({
      data: { codeHash: hashInviteCode(code), createdById, expiresAt, note },
      select: { id: true },
    });
    created.push({ id: row.id, code, expiresAt });
  }
  // Audit deliberately carries NO code material — only counts and ids.
  await audit({
    actorId: createdById,
    actorKind: "user",
    action: "invites.created",
    targetType: "ArtistInvite",
    targetId: created[0]!.id,
    payload: { count, expiresInDays, inviteIds: created.map((c) => c.id), note },
  });
  return created;
}

export type RedeemInput = { code: string; handle: string; displayName: string };

/**
 * Redeem an invite for the caller: claims the code atomically, creates the
 * artist profile and grants the ARTIST role in one transaction. Invalid,
 * reused, expired and malformed codes are indistinguishable (404
 * NO_SUCH_INVITE).
 */
export async function redeemInvite(userId: string, input: RedeemInput, client = defaultDb) {
  await checkOnboardingTexts(input.handle, input.displayName);
  const codeHash = hashInviteCode(input.code);

  try {
    const profile = await client.$transaction(async (tx) => {
      // Existing profile pre-check (a friendly 409; the userId unique index
      // is the hard guarantee under races).
      const existing = await tx.artistProfile.findUnique({ where: { userId } });
      if (existing) {
        throw new HttpError(409, "ARTIST_PROFILE_EXISTS", "You already have an artist profile");
      }
      // Atomic claim: only ONE concurrent redemption can flip usedById from
      // null; everyone else sees count 0 and gets the generic 404.
      const claimed = await tx.artistInvite.updateMany({
        where: { codeHash, usedById: null, expiresAt: { gt: new Date() } },
        data: { usedById: userId, usedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw new HttpError(404, "NO_SUCH_INVITE", "Invalid, used or expired invite code");
      }
      // Handle clash pre-check for a friendly error; the case-insensitive
      // functional unique index remains the hard guarantee.
      const clash = await tx.artistProfile.findFirst({
        where: { handle: { equals: input.handle, mode: "insensitive" } },
        select: { id: true },
      });
      if (clash) {
        throw new HttpError(409, "HANDLE_TAKEN", "Handle already in use");
      }
      const created = await tx.artistProfile.create({
        data: { userId, handle: input.handle, displayName: input.displayName },
      });
      await tx.user.update({ where: { id: userId }, data: { role: "ARTIST" } });
      return created;
    });

    await audit({
      actorId: userId,
      actorKind: "user",
      action: "invites.redeemed",
      targetType: "ArtistProfile",
      targetId: profile.id,
      payload: { handle: profile.handle },
    });
    return profile;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as { code?: string }).code === "P2002") {
      throw new HttpError(409, "HANDLE_TAKEN", "Handle already in use");
    }
    throw e;
  }
}

/**
 * Open-path profile creation: only when INVITE_ONLY=false. Note: this path
 * creates the profile but does NOT change the role (the naryad grants the
 * ARTIST role through redemption only).
 */
export async function createProfileOpen(
  userId: string,
  input: { handle: string; displayName: string; bio?: string },
  inviteOnly: boolean,
  client = defaultDb,
) {
  if (inviteOnly) {
    throw new HttpError(403, "INVITE_REQUIRED", "Artist onboarding is invite-only right now");
  }
  await checkOnboardingTexts(input.handle, input.displayName);
  try {
    const profile = await client.$transaction(async (tx) => {
      const existing = await tx.artistProfile.findUnique({ where: { userId } });
      if (existing) {
        throw new HttpError(409, "ARTIST_PROFILE_EXISTS", "You already have an artist profile");
      }
      const clash = await tx.artistProfile.findFirst({
        where: { handle: { equals: input.handle, mode: "insensitive" } },
        select: { id: true },
      });
      if (clash) {
        throw new HttpError(409, "HANDLE_TAKEN", "Handle already in use");
      }
      return tx.artistProfile.create({
        data: { userId, handle: input.handle, displayName: input.displayName, bio: input.bio ?? "" },
      });
    });
    await audit({
      actorId: userId,
      actorKind: "user",
      action: "artists.created",
      targetType: "ArtistProfile",
      targetId: profile.id,
      payload: { handle: profile.handle },
    });
    return profile;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if ((e as { code?: string }).code === "P2002") {
      throw new HttpError(409, "HANDLE_TAKEN", "Handle already in use");
    }
    throw e;
  }
}
