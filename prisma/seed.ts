// Seed skeleton (H-101): idempotent bootstrap of station-wide rows.
// No users, no tracks — those arrive with later naryads.
// The taxonomy below is a clearly marked PLACEHOLDER until H-402 replaces it.
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../src/server/env";

type TermSeed = { kind: "LANGUAGE" | "STYLE" | "DIRECTION"; slug: string; label: string };

const PLACEHOLDER_SUFFIX = " (placeholder until H-402)";

const PLACEHOLDER_TERMS: TermSeed[] = [
  { kind: "LANGUAGE", slug: "lang-en", label: "English" },
  { kind: "LANGUAGE", slug: "lang-ru", label: "Russian" },
  { kind: "LANGUAGE", slug: "lang-instr", label: "Instrumental" },
  { kind: "STYLE", slug: "style-synthwave", label: "Synthwave" },
  { kind: "STYLE", slug: "style-ambient", label: "Ambient" },
  { kind: "STYLE", slug: "style-rock", label: "Rock" },
  { kind: "DIRECTION", slug: "dir-discovery", label: "Discovery" },
  { kind: "DIRECTION", slug: "dir-classics", label: "Classics" },
  { kind: "DIRECTION", slug: "dir-experimental", label: "Experimental" },
];

export async function seed(db: PrismaClient): Promise<void> {
  await db.stationState.upsert({
    where: { id: "main" },
    update: {},
    create: { id: "main" },
  });

  for (const term of PLACEHOLDER_TERMS) {
    await db.taxonomyTerm.upsert({
      where: { kind_slug: { kind: term.kind, slug: term.slug } },
      update: {},
      create: { kind: term.kind, slug: term.slug, label: `${term.label}${PLACEHOLDER_SUFFIX}` },
    });
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
