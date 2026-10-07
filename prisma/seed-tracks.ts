// Seed-track registration (H-106): registers the procedurally generated
// seed audio (scripts/seed-content/make_seed.py) as SEED tracks. Idempotent:
// every run upserts by TrackSource.externalId (= file name), so running it
// twice leaves identical row counts.
//
// The script reads a directory produced by the generator:
//   <dir>/manifest.json  — slug/title/style metadata (sidecar from the generator)
//   <dir>/*.mp3          — the audio files
// durationSec is measured from the file with ffprobe (ffmpeg ships wherever
// the generator ran); sha256 and byteLength are computed from the bytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../src/server/env";

type ManifestEntry = { slug: string; file: string; title: string; style: string };

/** A file to register; injectable so the DB test needs no audio/ffmpeg. */
export interface SeedFileInput {
  fileName: string;
  bytes: Uint8Array;
  durationSec: number;
  /** Title from the generator manifest; falls back to the slug. */
  title?: string;
}

/** Measures audio duration in seconds via ffprobe; null when unavailable. */
export function probeDurationSec(path: string): number | null {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { encoding: "utf8" },
  );
  if (res.status !== 0) return null;
  const value = Number.parseFloat(res.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

/** Registers the given files as SEED tracks. Idempotent (upsert by externalId). */
export async function seedTracks(db: PrismaClient, files: SeedFileInput[]): Promise<void> {
  const env = loadEnv();
  const baseUrl = env.SEED_AUDIO_BASE_URL ?? "/seed";

  for (const file of files) {
    const contentHash = createHash("sha256").update(file.bytes).digest("hex");
    const byteLength = file.bytes.byteLength;
    const url = `${baseUrl.replace(/\/$/, "")}/${file.fileName}`;

    // Idempotency anchor: one SEED TrackSource row per file name.
    const existing = await db.trackSource.findFirst({
      where: { externalId: file.fileName, provider: "SEED" },
      include: { track: true },
    });

    const trackData = {
      title: file.title ?? file.fileName.replace(/\.mp3$/i, ""),
      status: "APPROVED" as const,
      moderatedBy: "seed",
      aiGenerated: true,
      aiTool: "procedural (HUK seed script)",
      licenseScope: "RADIO_AND_PLAYLISTS" as const,
      durationSec: file.durationSec,
    };

    if (existing) {
      await db.track.update({ where: { id: existing.trackId }, data: trackData });
      await db.trackSource.update({
        where: { id: existing.id },
        data: { url, contentHash, byteLength },
      });
      continue;
    }

    await db.track.create({
      data: {
        ...trackData,
        source: {
          create: { provider: "SEED", externalId: file.fileName, url, contentHash, byteLength },
        },
      },
    });
  }
}

function readManifest(dir: string): ManifestEntry[] {
  try {
    const raw = readFileSync(join(dir, "manifest.json"), "utf8");
    return JSON.parse(raw) as ManifestEntry[];
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
  const dir = process.argv[2] ?? join("public", "seed");
  if (!statSync(dir, { throwIfNoEntry: false })) {
    console.error(
      `[seed:tracks] directory not found: ${dir} — generate audio first ` +
        `(python3 scripts/seed-content/make_seed.py --out public/seed)`,
    );
    process.exit(1);
  }

  const manifest = readManifest(dir);
  const titles = new Map(manifest.map((m) => [m.file.replace(/\.mp3$/i, ""), m.title]));

  const files: SeedFileInput[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".mp3")) continue;
    const path = join(dir, name);
    const bytes = readFileSync(path);
    const durationSec = probeDurationSec(path);
    if (durationSec === null) {
      console.error(`[seed:tracks] skipping ${name}: ffprobe could not measure duration (ffmpeg required)`);
      continue;
    }
    files.push({ fileName: name, bytes, durationSec, title: titles.get(name.replace(/\.mp3$/i, "")) });
  }

  if (files.length === 0) {
    console.error(`[seed:tracks] no .mp3 files in ${dir}`);
    process.exit(1);
  }

  await seedTracks(db, files);
  console.log(`[seed:tracks] registered ${files.length} seed track(s) from ${dir}`);
  await db.$disconnect();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("[seed:tracks] failed:", error);
    process.exit(1);
  });
}
