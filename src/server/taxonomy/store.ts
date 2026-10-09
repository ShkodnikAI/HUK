// Taxonomy store operations (H-402): the vocabulary files in
// prisma/taxonomy/ are the source of truth; TaxonomyTerm is their DB
// mirror. The seed bulk-loads the mirror; these helpers upsert the exact
// rows a validated slug resolves to, so submission and moderator paths
// never depend on the seed having run and the mirror can never disagree
// with the files. TrackTerm rows written here are always `confirmed`
// (author/moderator attribution); unconfirmed rows are reserved for the
// later AI suggestions (follow H-208) and are never created here.

import type { Prisma, PrismaClient } from "@prisma/client";
import { vocabularyTerms, type TermKind } from "./vocabulary";

type Client = PrismaClient | Prisma.TransactionClient;

export type TermRef = { kind: TermKind; slug: string };

async function ensureTermRow(client: Client, ref: TermRef): Promise<string> {
  const term = vocabularyTerms([ref])[0];
  let parentId: string | null = null;
  if (term.parentId !== null) {
    // A style always hangs off its parent direction (vocabulary invariant).
    const parent = await ensureTermRow(client, { kind: "DIRECTION", slug: term.parentId });
    parentId = parent;
  }
  const row = await client.taxonomyTerm.upsert({
    where: { kind_slug: { kind: term.kind, slug: term.slug } },
    update: { label: term.label, parentId },
    create: { kind: term.kind, slug: term.slug, label: term.label, parentId },
  });
  return row.id;
}

/** Links `refs` to the track as confirmed terms, idempotent (submission path). */
export async function attachConfirmedTerms(
  client: Client,
  trackId: string,
  refs: readonly TermRef[],
): Promise<void> {
  if (refs.length === 0) return;
  for (const ref of refs) {
    const termId = await ensureTermRow(client, ref);
    await client.trackTerm.upsert({
      where: { trackId_termId: { trackId, termId } },
      update: { confirmed: true },
      create: { trackId, termId, confirmed: true },
    });
  }
}

/**
 * Replaces the track's confirmed terms of every kind present in `refs`
 * with exactly the given ones (moderator path); kinds absent from `refs`
 * are left untouched. Unknown slugs are a caller bug (the callers
 * validate against the vocabulary first) and fail loud (S9).
 */
export async function replaceConfirmedTerms(
  client: Client,
  trackId: string,
  refs: readonly TermRef[],
): Promise<void> {
  const kinds = [...new Set(refs.map((r) => r.kind))];
  await client.trackTerm.deleteMany({
    where: { trackId, term: { kind: { in: kinds } } },
  });
  await attachConfirmedTerms(client, trackId, refs);
}
