// Anti-fraud v1 (H-304, ADR-0006): cheap deterministic rules only — AI
// audits, it does not decide chart positions alone. A flagged vote weighs
// 0. Flags live in VoteFlag, are audited, and are never exposed.

import { PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/server/db";

/** Minimum trust of a brand-new account (rises to 1.0 over 14 days). */
export const NEW_ACCOUNT_REPUTATION = 0.2;
/** The reputation ramp reaches 1.0 at this account age (days). */
export const REPUTATION_RAMP_DAYS = 14;

/**
 * The reputation ramp (pure): 0.2 below 1 day of account age, rising
 * linearly to 1.0 at 14 days. Exact at day 0 (0.2), day 7 (0.2 + 0.8·6/13),
 * and day 14 (1.0).
 */
export function reputationFor(accountAgeDays: number): number {
  if (accountAgeDays <= 0) return NEW_ACCOUNT_REPUTATION;
  if (accountAgeDays >= REPUTATION_RAMP_DAYS) return 1.0;
  const t = (accountAgeDays - 1) / (REPUTATION_RAMP_DAYS - 1);
  return NEW_ACCOUNT_REPUTATION + (1 - NEW_ACCOUNT_REPUTATION) * Math.max(0, Math.min(1, t));
}

export type VoteRecord = {
  userId: string;
  trackId: string;
  /** ms between the account creation and the vote */
  accountAgeMs: number;
  /** rotating ip hash of the vote (may be null) */
  ipHash: string | null;
  createdAt: Date;
};

export type FraudFlag = {
  userId: string;
  trackId: string;
  reason: "vote-burst" | "ip-cluster";
};

const BURST_WINDOW_MS = 10 * 60 * 1000;
const BURST_MIN_VOTES = 5;
const BURST_MAX_ACCOUNT_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const IP_CLUSTER_MAX_VOTES = 2;

/**
 * (a) vote burst: at least 5 votes within 10 minutes on ONE track from
 * accounts younger than 3 days (a bot ring — accounts are distinct by the
 * Reaction key, one vote per user and track). Pure — the caller supplies
 * the votes. Every vote in the burst is flagged.
 */
export function detectVoteBursts(votes: readonly VoteRecord[]): FraudFlag[] {
  const flags: FraudFlag[] = [];
  const byTrack = new Map<string, VoteRecord[]>();
  for (const vote of votes) {
    if (vote.accountAgeMs >= BURST_MAX_ACCOUNT_AGE_MS) continue;
    const list = byTrack.get(vote.trackId) ?? [];
    list.push(vote);
    byTrack.set(vote.trackId, list);
  }
  for (const [trackId, list] of byTrack) {
    const sorted = [...list].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (let i = 0; i + BURST_MIN_VOTES <= sorted.length; i++) {
      const window = sorted[i + BURST_MIN_VOTES - 1].createdAt.getTime() - sorted[i].createdAt.getTime();
      if (window <= BURST_WINDOW_MS) {
        for (const v of sorted.slice(i, i + BURST_MIN_VOTES)) {
          flags.push({ userId: v.userId, trackId, reason: "vote-burst" });
        }
        break; // one burst per track per pass
      }
    }
  }
  return flags;
}

/**
 * (b) ipHash cluster: more than 2 votes on ONE track from ONE hash within
 * one UTC day. Pure — the caller supplies the votes.
 */
export function detectIpClusters(votes: readonly VoteRecord[]): FraudFlag[] {
  const flags: FraudFlag[] = [];
  const byHashTrack = new Map<string, VoteRecord[]>();
  for (const vote of votes) {
    if (!vote.ipHash) continue;
    const day = vote.createdAt.toISOString().slice(0, 10);
    const key = `${day}:${vote.ipHash}:${vote.trackId}`;
    const list = byHashTrack.get(key) ?? [];
    list.push(vote);
    byHashTrack.set(key, list);
  }
  for (const list of byHashTrack.values()) {
    if (list.length > IP_CLUSTER_MAX_VOTES) {
      const distinctUsers = new Set(list.map((v) => v.userId));
      for (const userId of distinctUsers) {
        flags.push({ userId, trackId: list[0].trackId, reason: "ip-cluster" });
      }
    }
  }
  return flags;
}

/**
 * The daily anti-fraud pass (leader-gated, bounded, idempotent): flags the
 * recent day of votes with weight-0 rules and writes one audit entry.
 * Returns the number of NEW flags written.
 */
export async function runAntifraudPass(
  seam: { client?: PrismaClient; now?: () => Date } = {},
): Promise<{ newFlags: number; checked: number }> {
  const client = seam.client ?? defaultDb;
  const now = (seam.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const votes = await client.reaction.findMany({
    where: { createdAt: { gte: since } },
    select: { userId: true, trackId: true, ipHash: true, createdAt: true, user: { select: { createdAt: true } } },
    take: 5000,
    orderBy: { createdAt: "asc" },
  });

  const records: VoteRecord[] = votes.map((v) => ({
    userId: v.userId,
    trackId: v.trackId,
    ipHash: v.ipHash,
    createdAt: v.createdAt,
    accountAgeMs: v.createdAt.getTime() - v.user.createdAt.getTime(),
  }));

  const flags = [...detectVoteBursts(records), ...detectIpClusters(records)];
  let newFlags = 0;
  for (const flag of flags) {
    const existing = await client.voteFlag.findUnique({
      where: { userId_trackId_reason: { userId: flag.userId, trackId: flag.trackId, reason: flag.reason } },
      select: { userId: true },
    });
    if (existing) continue; // idempotent
    await client.voteFlag.create({ data: flag });
    newFlags++;
  }
  if (newFlags > 0) {
    const { audit } = await import("@/server/audit");
    await audit({
      actorKind: "worker",
      action: "antifraud.flags",
      targetType: "System",
      targetId: "antifraud",
      payload: { newFlags, checked: records.length },
    });
  }
  return { newFlags, checked: records.length };
}

/**
 * (a) the daily reputation job: reputation = ramp(account age). Idempotent,
 * bounded; only touches accounts below the ramp ceiling.
 */
export async function updateReputations(seam: { client?: PrismaClient; now?: () => Date } = {}): Promise<number> {
  const client = seam.client ?? defaultDb;
  const now = (seam.now ?? (() => new Date()))();
  const ceiling = new Date(now.getTime() - REPUTATION_RAMP_DAYS * 24 * 60 * 60 * 1000);
  // Accounts older than the ramp are already at 1.0 (default) — only
  // younger rows are touched (bounded by the ramp window).
  const young = await client.user.findMany({
    where: { createdAt: { gte: ceiling } },
    select: { id: true, createdAt: true, reputation: true },
    take: 5000,
  });
  let updated = 0;
  for (const user of young) {
    const ageDays = (now.getTime() - user.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    const next = Math.round(reputationFor(ageDays) * 1000) / 1000;
    if (Math.abs(next - user.reputation) > 1e-9) {
      await client.user.update({ where: { id: user.id }, data: { reputation: next } });
      updated++;
    }
  }
  return updated;
}
