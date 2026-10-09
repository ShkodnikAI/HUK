// Seed (H-402 replaces the H-101 placeholder): idempotent bootstrap of
// station-wide rows. No users, no tracks — those arrive with later naryads.
// The taxonomy is the controlled vocabulary from prisma/taxonomy/*.json
// (Owner decision 2026-10-08): upsert by kind+slug, styles linked to their
// parent direction. The retired placeholder rows are deleted so a DB seeded
// before H-402 converges to the vocabulary; they never had TrackTerm links.
// Run twice → identical counts.

import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../src/server/env";
import { LANGUAGES, DIRECTIONS, STYLES } from "../src/server/taxonomy/vocabulary";

/** Placeholder rows from the H-101 seed, retired by H-402. */
const RETIRED_PLACEHOLDERS = [
  { kind: "LANGUAGE" as const, slug: "lang-en" },
  { kind: "LANGUAGE" as const, slug: "lang-ru" },
  { kind: "LANGUAGE" as const, slug: "lang-instr" },
  { kind: "STYLE" as const, slug: "style-synthwave" },
  { kind: "STYLE" as const, slug: "style-ambient" },
  { kind: "STYLE" as const, slug: "style-rock" },
  { kind: "DIRECTION" as const, slug: "dir-discovery" },
  { kind: "DIRECTION" as const, slug: "dir-classics" },
  { kind: "DIRECTION" as const, slug: "dir-experimental" },
];

export async function seed(db: PrismaClient): Promise<void> {
  await db.stationState.upsert({
    where: { id: "main" },
    update: {},
    create: { id: "main" },
  });

  for (const [slug, label] of Object.entries(LANGUAGES)) {
    await db.taxonomyTerm.upsert({
      where: { kind_slug: { kind: "LANGUAGE", slug } },
      update: { label, parentId: null },
      create: { kind: "LANGUAGE", slug, label },
    });
  }
  for (const [slug, label] of Object.entries(DIRECTIONS)) {
    await db.taxonomyTerm.upsert({
      where: { kind_slug: { kind: "DIRECTION", slug } },
      update: { label, parentId: null },
      create: { kind: "DIRECTION", slug, label },
    });
  }
  for (const [slug, def] of Object.entries(STYLES)) {
    const parent = await db.taxonomyTerm.findUniqueOrThrow({
      where: { kind_slug: { kind: "DIRECTION", slug: def.parent } },
      select: { id: true },
    });
    await db.taxonomyTerm.upsert({
      where: { kind_slug: { kind: "STYLE", slug } },
      update: { label: def.label, parentId: parent.id },
      create: { kind: "STYLE", slug, label: def.label, parentId: parent.id },
    });
  }

  for (const term of RETIRED_PLACEHOLDERS) {
    await db.taxonomyTerm.deleteMany({ where: { kind: term.kind, slug: term.slug } });
  }
}

if (import.meta.main) {
  const env = loadEnv();
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  seed(db)
    .then(() => console.log("[seed] done"))
    .catch((error) => {
      console.error("[seed] failed:", error);
      process.exit(1);
    })
    .then(() => db.$disconnect());
}
