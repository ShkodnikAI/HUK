// Server-verified listening (H-301, ARCHITECTURE §9): a vote or comment
// needs at least 30 s of VERIFIED listening. The player opens a session,
// beats every 10 s, and the server credits each beat with
//   min(now − lastBeatAt, 15 s, remaining duration)
// capped by a 5 s minimum spacing (a sooner beat earns nothing) and, for
// RADIO, by the remaining slot time. Verification proves elapsed
// wall-clock time, not audibility (see docs/LIMITATIONS.md).
//
// S7: sessions carry only the rotating user/anon hash — no raw IP; closed
// sessions are purged after 48 h (H-210 job). Every closed session writes
// exactly one ListenEvent (the aggregation row for the H-304 ranker).

import { loadEnv, type Env } from "@/server/env";
import { db as defaultDb } from "@/server/db";
import { HttpError } from "@/server/http/errors";
import { hashIp } from "@/server/iphash";

/** Anon ids are hashed with the daily-rotating salt (like client IPs). */
export function hashAnonId(anonId: string, now: Date, env: Env): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(anonId)) {
    throw new HttpError(400, "INVALID_ANON_ID", "anonId must be 16..128 url-safe characters");
  }
  return hashIp(anonId, now, env);
}

export type ListenIdentity = { userId: string | null; anonHash: string | null };

export type StartListenInput = {
  trackId: string;
  mode: "RADIO" | "PLAYLIST";
  /** Anonymous listeners supply a random client id; it is hashed, never stored. */
  anonId?: string;
};

/** Identity derived from the start input: the anon hash is computed once. */
export async function identityFromInput(input: { anonId?: string }, userId: string | null, seam: StartListenSeam = {}): Promise<ListenIdentity> {
  return {
    userId,
    anonHash: input.anonId ? hashAnonId(input.anonId, (seam.now ?? (() => new Date()))(), seam.env ?? loadEnv()) : null,
  };
}

export type StartListenSeam = {
  client?: typeof defaultDb;
  env?: Env;
  now?: () => Date;
};

export async function startListenSession(
  input: StartListenInput,
  identity: ListenIdentity,
  seam: StartListenSeam = {},
): Promise<{ sessionId: string }> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());
  if (!identity.userId && !input.anonId) {
    throw new HttpError(400, "NO_IDENTITY", "signed-in user or anonId required");
  }
  const anonHash = input.anonId ? hashAnonId(input.anonId, now(), seam.env ?? loadEnv()) : null;

  const track = await client.track.findUnique({
    where: { id: input.trackId },
    select: { id: true, status: true, available: true, licenseScope: true },
  });
  if (!track) throw new HttpError(404, "TRACK_NOT_FOUND", `no track ${input.trackId}`);

  if (input.mode === "RADIO") {
    // S2 (H-110): RADIO verification exists only while the track is the
    // currently scheduled slot — the timeline is the source of truth.
    const at = now();
    const slot = await client.broadcastSlot.findFirst({
      where: { trackId: input.trackId, startsAt: { lte: at }, endsAt: { gt: at } },
      orderBy: { startsAt: "asc" },
    });
    if (!slot) {
      throw new HttpError(409, "NOT_ON_AIR", `track ${input.trackId} is not the current RADIO slot`);
    }
  } else {
    // PLAYLIST (H-302): eligibility is re-checked at play time — an
    // APPROVED, available track whose licence allows on-demand play. A
    // RADIO_ONLY track must never be playable on demand (Owner-approved).
    if (track.status !== "APPROVED" || !track.available) {
      throw new HttpError(409, "TRACK_NOT_PUBLIC", `track ${input.trackId} is not public`);
    }
    if (track.licenseScope !== "RADIO_AND_PLAYLISTS") {
      throw new HttpError(409, "TRACK_LICENSED_RADIO_ONLY", `track ${input.trackId} may not be played on demand`);
    }
  }

  const session = await client.listenSession.create({
    data: {
      userId: identity.userId,
      anonHash,
      trackId: input.trackId,
      mode: input.mode,
      startedAt: now(),
      lastBeatAt: now(),
    },
    select: { id: true },
  });
  return { sessionId: session.id };
}

export type BeatInput = {
  sessionId: string;
  skipped?: boolean;
};

export type BeatSeam = StartListenSeam;

export type BeatResult = {
  verifiedMs: number;
  /** True when this beat closed the session (skipped or lapsed). */
  closed: boolean;
};

/** A beat sooner than this after the previous one earns nothing (H-301). */
export const MIN_BEAT_SPACING_MS = 5_000;
/** One beat can never credit more than this much wall time. */
export const MAX_CREDIT_MS = 15_000;
/** No beat for this long closes the session; a late beat earns nothing. */
export const LAPSE_MS = 60_000;
/** ARCHITECTURE §9: the reaction gate. */
export const VERIFIED_FOR_REACTION_MS = 30_000;

/**
 * Credits one beat. Fail closed: a session that does not belong to the
 * caller is rejected (403); a lapsed session (> 60 s without a beat) closes
 * with NO credit for the late beat; a closed session answers 409.
 */
export async function beat(input: BeatInput, identity: ListenIdentity, seam: BeatSeam = {}): Promise<BeatResult> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());

  const session = await client.listenSession.findUnique({ where: { id: input.sessionId } });
  if (!session) throw new HttpError(404, "SESSION_NOT_FOUND", `no session ${input.sessionId}`);
  if (session.closedAt) throw new HttpError(409, "SESSION_CLOSED", "this listen session is already closed");
  // Ownership: the session must belong to the same user or the same anon hash.
  if (identity.userId) {
    if (session.userId !== identity.userId) throw new HttpError(403, "SESSION_OWNER", "not your session");
  } else if (identity.anonHash) {
    if (session.anonHash !== identity.anonHash) throw new HttpError(403, "SESSION_OWNER", "not your session");
  } else {
    throw new HttpError(400, "NO_IDENTITY", "signed-in user or anonId required");
  }

  const track = await client.track.findUniqueOrThrow({
    where: { id: session.trackId },
    select: { durationSec: true },
  });
  const durationMs = Math.max(1, Math.round(track.durationSec * 1000));

  const at = now();
  const elapsed = at.getTime() - session.lastBeatAt.getTime();

  // The session lapsed: close it with the verified time so far; this late
  // beat earns nothing.
  if (elapsed > LAPSE_MS) {
    await closeSession(session.id, { skipped: input.skipped ?? false, now: at, client });
    return { verifiedMs: session.verifiedMs, closed: true };
  }

  let credit = Math.min(elapsed, MAX_CREDIT_MS, Math.max(0, durationMs - session.verifiedMs));
  if (elapsed < MIN_BEAT_SPACING_MS) credit = 0; // sooner than 5 s earns nothing

  let verifiedMs = session.verifiedMs + credit;
  if (session.mode === "RADIO") {
    // RADIO: the scheduled timeline is the source of truth (S2). A beat
    // after the slot has rotated away earns nothing; while the slot is
    // live, credit is capped at the slot end.
    const slot = await client.broadcastSlot.findFirst({
      where: { trackId: session.trackId, startsAt: { lte: at }, endsAt: { gt: at } },
      orderBy: { startsAt: "asc" },
    });
    if (!slot) {
      verifiedMs = session.verifiedMs; // no live slot — nothing verifiable
    } else {
      const slotRemaining = Math.max(0, slot.endsAt.getTime() - at.getTime());
      verifiedMs = Math.min(verifiedMs, session.verifiedMs + slotRemaining);
    }
  }

  const completed = verifiedMs >= 0.8 * durationMs || session.completed;

  if (input.skipped) {
    // An explicit skip closes the session; the credit earned by THIS beat
    // still counts (it was verified listening up to the skip).
    await client.listenSession.update({
      where: { id: session.id },
      data: { verifiedMs, completed, lastBeatAt: at },
    });
    await closeSession(session.id, { skipped: true, now: at, client });
    return { verifiedMs, closed: true };
  }

  await client.listenSession.update({
    where: { id: session.id },
    data: {
      verifiedMs,
      completed,
      ...(credit > 0 ? { lastBeatAt: at } : {}), // a zero-credit beat does not advance the 5 s window
    },
  });
  return { verifiedMs, closed: false };
}

/**
 * Closes a session and writes exactly ONE ListenEvent (idempotent: an
 * already-closed session is left untouched).
 */
export async function closeSession(
  sessionId: string,
  opts: { skipped: boolean; now: Date; client: typeof defaultDb },
): Promise<void> {
  const { client } = opts;
  const session = await client.listenSession.findUnique({ where: { id: sessionId } });
  if (!session || session.closedAt) return;
  const event = client.listenEvent.create({
    data: {
      userId: session.userId,
      anonHash: session.anonHash,
      trackId: session.trackId,
      mode: session.mode,
      msListened: session.verifiedMs,
      completed: session.completed,
      skippedEarly: opts.skipped && session.verifiedMs < VERIFIED_FOR_REACTION_MS,
      createdAt: opts.now,
    },
  });
  await client.$transaction([event, client.listenSession.update({ where: { id: session.id }, data: { closedAt: opts.now } })]);
}

/**
 * Closes sessions idle for more than 60 s (the beat loop vanished — tab
 * closed without a final beacon, crash). Returns how many were closed.
 */
export async function closeStaleSessions(seam: StartListenSeam = {}): Promise<number> {
  const client = seam.client ?? defaultDb;
  const now = seam.now ?? (() => new Date());
  const stale = await client.listenSession.findMany({
    where: { closedAt: null, lastBeatAt: { lt: new Date(now().getTime() - LAPSE_MS) } },
    select: { id: true },
    take: 500,
  });
  for (const s of stale) {
    await closeSession(s.id, { skipped: false, now: now(), client });
  }
  return stale.length;
}
