// Playlists (H-302, ARCHITECTURE §6): personal playlists with PRIVATE /
// UNLISTED / PUBLIC visibility. Owner-approved licence rule: a
// RADIO_ONLY track must never be playable on demand — only APPROVED,
// available tracks with licenseScope = RADIO_AND_PLAYLISTS are addable and
// playable; a track that loses eligibility later stays in the playlist as
// an untitled `unavailable` placeholder (no leak of removed content).
//
// Limits (race-safe via a pg advisory xact lock on the owner/playlist):
// 50 playlists per user, 500 tracks per playlist. All user text goes
// through the central textCheck hook (H-209) plus the local validators.

import { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";
import { HttpError } from "@/server/http/errors";

export const MAX_PLAYLISTS_PER_USER = 50;
export const MAX_TRACKS_PER_PLAYLIST = 500;
export const MAX_IMPORT_IDS = 500;

export type PlaylistVisibility = "PRIVATE" | "UNLISTED" | "PUBLIC";

export type PlaylistSeam = {
  client?: PrismaClient;
  /** The central user-text hook (H-209); injectable for spy tests. */
  textCheck?: (text: string) => Promise<boolean>;
};

const defaultTextCheck = async (text: string): Promise<boolean> => {
  const { textCheck } = await import("@/server/artists/text-check");
  return textCheck(text);
};

/** Any control character (Unicode Cc plus C1) — never allowed in user text. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
/** Links are not allowed in playlist names/descriptions. */
const LINK = /(https?:\/\/|www\.)[^\s]*|\b[\w-]+\.(com|net|org|ru|io|xyz|info|biz|ua|by|de|uk)\b/i;

/** Local validation (S5-adjacent): any script, but no control chars, no links. */
export function validatePlaylistText(text: string): boolean {
  if (CONTROL_CHARS.test(text)) return false;
  if (LINK.test(text)) return false;
  return true;
}

async function assertTextAcceptable(text: string, field: string, seam: PlaylistSeam): Promise<void> {
  if (!validatePlaylistText(text)) {
    throw new HttpError(422, "TEXT_REJECTED", `${field}: control characters or links are not allowed`);
  }
  const ok = await (seam.textCheck ?? defaultTextCheck)(text);
  if (!ok) {
    throw new HttpError(422, "TEXT_REJECTED", `${field}: rejected by the text check`);
  }
}

export type PlaylistItemView =
  | { trackId: string; position: number; unavailable: true }
  | { trackId: string; position: number; unavailable: false; title: string; artist: string | null; durationSec: number; audioUrl: string };

export type PlaylistView = {
  id: string;
  name: string;
  description: string;
  visibility: PlaylistVisibility;
  items: PlaylistItemView[];
};

/** Eligibility (Owner-approved licence rule): addable AND playable. */
export function isEligible(track: { status: string; available: boolean; licenseScope: string }): boolean {
  return track.status === "APPROVED" && track.available && track.licenseScope === "RADIO_AND_PLAYLISTS";
}

export async function createPlaylist(
  userId: string,
  input: { name: string; description?: string; visibility?: PlaylistVisibility },
  seam: PlaylistSeam = {},
): Promise<{ id: string }> {
  const client = seam.client ?? defaultDb;
  await assertTextAcceptable(input.name, "name", seam);
  await assertTextAcceptable(input.description ?? "", "description", seam);

  // Race-safe limit: one lock per owner serialises count+create.
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"playlist-limit:" + userId}))`;
    const count = await tx.playlist.count({ where: { ownerId: userId } });
    if (count >= MAX_PLAYLISTS_PER_USER) {
      throw new HttpError(409, "PLAYLIST_LIMIT", `a user may own at most ${MAX_PLAYLISTS_PER_USER} playlists`);
    }
    const created = await tx.playlist.create({
      data: {
        ownerId: userId,
        name: input.name,
        description: input.description ?? "",
        visibility: input.visibility ?? "PRIVATE",
      },
      select: { id: true },
    });
    return created;
  });
}

export async function listPlaylists(userId: string, seam: PlaylistSeam = {}): Promise<
  Array<{ id: string; name: string; visibility: PlaylistVisibility; itemCount: number }>
> {
  const client = seam.client ?? defaultDb;
  const rows = await client.playlist.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, visibility: true, _count: { select: { items: true } } },
  });
  return rows.map((r) => ({ id: r.id, name: r.name, visibility: r.visibility, itemCount: r._count.items }));
}

/**
 * Reads one playlist. PRIVATE is owner-only — anyone else gets a 404 that
 * does not reveal whether the playlist exists. Ineligible tracks render as
 * untitled `unavailable` placeholders (no leak of removed content).
 */
export async function getPlaylist(
  playlistId: string,
  viewerId: string | null,
  seam: PlaylistSeam = {},
): Promise<PlaylistView> {
  const client = seam.client ?? defaultDb;
  const playlist = await client.playlist.findUnique({
    where: { id: playlistId },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: { track: { select: { status: true, available: true, licenseScope: true, title: true, durationSec: true, source: { select: { url: true } } } } },
      },
    },
  });
  if (!playlist) throw new HttpError(404, "NOT_FOUND", "no such playlist");
  const isOwner = viewerId !== null && playlist.ownerId === viewerId;
  if (playlist.visibility === "PRIVATE" && !isOwner) {
    throw new HttpError(404, "NOT_FOUND", "no such playlist");
  }
  return {
    id: playlist.id,
    name: playlist.name,
    description: playlist.description,
    visibility: playlist.visibility,
    items: playlist.items.map((item) => {
      if (!isEligible(item.track)) {
        return { trackId: item.trackId, position: item.position, unavailable: true as const };
      }
      return {
        trackId: item.trackId,
        position: item.position,
        unavailable: false as const,
        title: item.track.title,
        artist: null,
        durationSec: item.track.durationSec,
        audioUrl: item.track.source?.url ?? "",
      };
    }),
  };
}

export async function updatePlaylist(
  playlistId: string,
  userId: string,
  input: { name?: string; description?: string; visibility?: PlaylistVisibility },
  seam: PlaylistSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  if (input.name !== undefined) await assertTextAcceptable(input.name, "name", seam);
  if (input.description !== undefined) await assertTextAcceptable(input.description, "description", seam);
  const existing = await client.playlist.findUnique({ where: { id: playlistId }, select: { ownerId: true } });
  if (!existing || existing.ownerId !== userId) {
    throw new HttpError(404, "NOT_FOUND", "no such playlist");
  }
  await client.playlist.update({ where: { id: playlistId }, data: input });
}

export async function deletePlaylist(playlistId: string, userId: string, seam: PlaylistSeam = {}): Promise<void> {
  const client = seam.client ?? defaultDb;
  const existing = await client.playlist.findUnique({ where: { id: playlistId }, select: { ownerId: true } });
  if (!existing || existing.ownerId !== userId) {
    throw new HttpError(404, "NOT_FOUND", "no such playlist");
  }
  await client.playlist.delete({ where: { id: playlistId } });
}

/** Adds a track (owner only). Eligibility is enforced HERE and at play time. */
export async function addItem(
  playlistId: string,
  userId: string,
  trackId: string,
  seam: PlaylistSeam = {},
): Promise<{ position: number }> {
  const client = seam.client ?? defaultDb;
  const track = await client.track.findUnique({
    where: { id: trackId },
    select: { status: true, available: true, licenseScope: true },
  });
  if (!track) throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${trackId}`);
  if (!isEligible(track)) {
    throw new HttpError(409, "TRACK_INELIGIBLE", "only public RADIO_AND_PLAYLISTS tracks can be added");
  }
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"playlist-limit:" + playlistId}))`;
    const playlist = await tx.playlist.findUnique({ where: { id: playlistId }, select: { ownerId: true } });
    if (!playlist || playlist.ownerId !== userId) {
      throw new HttpError(404, "NOT_FOUND", "no such playlist");
    }
    const count = await tx.playlistItem.count({ where: { playlistId } });
    if (count >= MAX_TRACKS_PER_PLAYLIST) {
      throw new HttpError(409, "PLAYLIST_FULL", `a playlist holds at most ${MAX_TRACKS_PER_PLAYLIST} tracks`);
    }
    const dupe = await tx.playlistItem.findUnique({
      where: { playlistId_trackId: { playlistId, trackId } },
      select: { position: true },
    });
    if (dupe) throw new HttpError(409, "ALREADY_IN_PLAYLIST", "the track is already in this playlist");
    await tx.playlistItem.create({ data: { playlistId, trackId, position: count } });
    return { position: count };
  });
}

export async function removeItem(
  playlistId: string,
  userId: string,
  trackId: string,
  seam: PlaylistSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  const playlist = await client.playlist.findUnique({ where: { id: playlistId }, select: { ownerId: true } });
  if (!playlist || playlist.ownerId !== userId) {
    throw new HttpError(404, "NOT_FOUND", "no such playlist");
  }
  const item = await client.playlistItem.findUnique({
    where: { playlistId_trackId: { playlistId, trackId } },
    select: { position: true },
  });
  if (!item) return; // idempotent
  await client.$transaction([
    client.playlistItem.delete({ where: { playlistId_trackId: { playlistId, trackId } } }),
    // Keep positions contiguous: close the gap.
    client.playlistItem.updateMany({
      where: { playlistId, position: { gt: item.position } },
      data: { position: { decrement: 1 } },
    }),
  ]);
}

/** Reorders the items; `trackIds` in the new order must cover ALL items. */
export async function reorderItems(
  playlistId: string,
  userId: string,
  trackIds: string[],
  seam: PlaylistSeam = {},
): Promise<void> {
  const client = seam.client ?? defaultDb;
  const playlist = await client.playlist.findUnique({ where: { id: playlistId }, select: { ownerId: true } });
  if (!playlist || playlist.ownerId !== userId) {
    throw new HttpError(404, "NOT_FOUND", "no such playlist");
  }
  const items = await client.playlistItem.findMany({ where: { playlistId }, select: { trackId: true } });
  const current = new Set(items.map((i) => i.trackId));
  if (trackIds.length !== current.size || new Set(trackIds).size !== trackIds.length || !trackIds.every((t) => current.has(t))) {
    throw new HttpError(422, "INVALID_ORDER", "the new order must contain every item exactly once");
  }
  await client.$transaction(
    trackIds.map((trackId, position) =>
      client.playlistItem.update({
        where: { playlistId_trackId: { playlistId, trackId } },
        data: { position },
      }),
    ),
  );
}

/**
 * Guest-playlist import (H-302): creates a playlist from locally stored
 * track ids. Ids that do not exist or are ineligible are DROPPED and
 * reported (never leaked as titles).
 */
export async function importPlaylist(
  userId: string,
  input: { name: string; trackIds: string[] },
  seam: PlaylistSeam = {},
): Promise<{ id: string; added: number; dropped: string[] }> {
  const client = seam.client ?? defaultDb;
  if (input.trackIds.length === 0) {
    throw new HttpError(422, "EMPTY_IMPORT", "no track ids supplied");
  }
  const ids = input.trackIds.slice(0, MAX_IMPORT_IDS);
  const tracks = await client.track.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, available: true, licenseScope: true },
  });
  const dropped = ids.filter((id) => !tracks.some((t) => t.id === id && isEligible(t)));
  const added = ids.filter((id) => tracks.some((t) => t.id === id && isEligible(t)));
  const { id } = await createPlaylist(userId, { name: input.name, visibility: "PRIVATE" }, seam);
  await client.playlistItem.createMany({
    data: added.map((trackId, position) => ({ playlistId: id, trackId, position })),
  });
  return { id, added: added.length, dropped };
}
