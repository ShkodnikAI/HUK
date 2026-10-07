import { beforeEach, describe, expect, it } from "vitest";
import { cleanTables, databaseUrl, makeClient, skipMessage } from "./helpers";
import { seed } from "../../prisma/seed";

// DB integration tests (H-101), single file so the suites never run in
// parallel workers: every suite TRUNCATEs the shared tables in beforeEach and
// would race another file's fixtures. One test per DB constraint introduced
// by the H-101 migration (prisma/migrations/*_constraints); every test proves
// an invalid row is rejected by Postgres, and the valid baselines prove the
// constraints are not over-tight. Case-insensitive uniqueness covered for
// User.email and ArtistProfile.handle; seed idempotency covered at the end.

if (!databaseUrl) console.log(skipMessage());

describe.skipIf(!databaseUrl)("DB constraints (H-101)", () => {
  const db = makeClient();

  beforeEach(async () => {
    await cleanTables(db);
  });

  it("connects to the database at DATABASE_URL (fails loudly when unreachable)", async () => {
    await expect(db.$queryRaw`SELECT 1`).resolves.toBeTruthy();
  });

  it("rejects a second User whose email differs only by case (lower(email) unique)", async () => {
    await db.user.create({ data: { email: "A@x.com", reputation: 1 } });
    await expect(db.user.create({ data: { email: "a@x.com", reputation: 1 } })).rejects.toThrow();
    await expect(db.user.findMany()).resolves.toHaveLength(1);
  });

  it("rejects a second ArtistProfile whose handle differs only by case (lower(handle) unique)", async () => {
    const first = await db.user.create({ data: { email: "one@x.com", reputation: 1 } });
    const second = await db.user.create({ data: { email: "two@x.com", reputation: 1 } });
    await db.artistProfile.create({ data: { userId: first.id, handle: "Alpha", displayName: "A" } });
    await expect(
      db.artistProfile.create({ data: { userId: second.id, handle: "alpha", displayName: "B" } }),
    ).rejects.toThrow();
  });

  it("rejects a Track with negative durationSec", async () => {
    await expect(
      db.track.create({ data: { title: "ok", durationSec: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Track with aiConfidence outside [0, 1] (null is allowed)", async () => {
    await expect(
      db.track.create({ data: { title: "ok", aiConfidence: 1.5 } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(db.track.create({ data: { title: "null is fine", aiConfidence: null } })).resolves.toBeTruthy();
  });

  it("rejects a ModerationRun with confidence outside [0, 1]", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.moderationRun.create({
        data: { trackId: track.id, stage: "TECHNICAL", verdict: "APPROVE", confidence: -0.1 },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a ListenEvent with negative msListened", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.listenEvent.create({ data: { trackId: track.id, mode: "RADIO", msListened: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a PlaylistItem with negative position", async () => {
    const owner = await db.user.create({ data: { email: "p@x.com", reputation: 1 } });
    const track = await db.track.create({ data: { title: "ok" } });
    const playlist = await db.playlist.create({ data: { ownerId: owner.id, name: "mix" } });
    await expect(
      db.playlistItem.create({ data: { playlistId: playlist.id, trackId: track.id, position: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a ChartEntry with rank below 1", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    const snapshot = await db.chartSnapshot.create({
      data: { weekStart: new Date("2026-10-05T00:00:00Z"), categoryKey: "all" },
    });
    await expect(
      db.chartEntry.create({ data: { snapshotId: snapshot.id, rank: 0, trackId: track.id, score: 1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a User with negative reputation", async () => {
    await expect(
      db.user.create({ data: { email: "neg@x.com", reputation: -0.5 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a TrackSource with negative failCount", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.trackSource.create({
        data: { trackId: track.id, provider: "DIRECT_URL", url: "https://example.com/a.mp3", failCount: -1 },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Report with negative urgency", async () => {
    await expect(
      db.report.create({ data: { targetType: "TRACK", targetId: "cuid1", reason: "r", urgency: -1 } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a BroadcastSlot whose endsAt is not after startsAt", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    const start = new Date("2026-10-07T10:00:00Z");
    await expect(
      db.broadcastSlot.create({
        data: { seq: 1n, trackId: track.id, startsAt: start, endsAt: new Date(start.getTime() - 1000) },
      }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("rejects a Track with an empty or over-200-char title", async () => {
    await expect(db.track.create({ data: { title: "" } })).rejects.toThrow(/violates check constraint/);
    await expect(
      db.track.create({ data: { title: "x".repeat(201) } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(db.track.create({ data: { title: "x".repeat(200) } })).resolves.toBeTruthy();
  });

  it("rejects a Comment with a body over 2000 chars", async () => {
    const track = await db.track.create({ data: { title: "ok" } });
    await expect(
      db.comment.create({ data: { trackId: track.id, body: "x".repeat(2001) } }),
    ).rejects.toThrow(/violates check constraint/);
    await expect(
      db.comment.create({ data: { trackId: track.id, body: "x".repeat(2000) } }),
    ).resolves.toBeTruthy();
  });

  it("rejects a Playlist with an empty or over-100-char name", async () => {
    const owner = await db.user.create({ data: { email: "n@x.com", reputation: 1 } });
    await expect(db.playlist.create({ data: { ownerId: owner.id, name: "" } })).rejects.toThrow(
      /violates check constraint/,
    );
    await expect(
      db.playlist.create({ data: { ownerId: owner.id, name: "x".repeat(101) } }),
    ).rejects.toThrow(/violates check constraint/);
  });

  it("accepts a valid end-to-end graph (constraints are not over-tight)", async () => {
    const user = await db.user.create({ data: { email: "Main@X.com", reputation: 1 } });
    const artist = await db.artistProfile.create({
      data: { userId: user.id, handle: "Alpha", displayName: "Alpha" },
    });
    const track = await db.track.create({
      data: { title: "Song", artistId: artist.id, durationSec: 180, aiConfidence: 0.5 },
    });
    await db.trackSource.create({
      data: { trackId: track.id, provider: "DIRECT_URL", url: "https://example.com/a.mp3", failCount: 0 },
    });
    await db.broadcastSlot.create({
      data: {
        seq: 1n,
        trackId: track.id,
        startsAt: new Date("2026-10-07T10:00:00Z"),
        endsAt: new Date("2026-10-07T10:03:00Z"),
      },
    });
    await expect(db.track.count()).resolves.toBe(1);
  });
});

describe.skipIf(!databaseUrl)("seed (H-101)", () => {
  const db = makeClient();

  beforeEach(async () => {
    await cleanTables(db);
  });

  it("is idempotent: two runs leave identical row counts", async () => {
    await seed(db);
    const afterFirst = {
      stationStates: await db.stationState.count(),
      terms: await db.taxonomyTerm.count(),
    };

    await seed(db);
    const afterSecond = {
      stationStates: await db.stationState.count(),
      terms: await db.taxonomyTerm.count(),
    };

    expect(afterSecond).toEqual(afterFirst);
    expect(afterSecond.stationStates).toBe(1);
    expect(afterSecond.terms).toBe(9); // 3 per kind: LANGUAGE, STYLE, DIRECTION
  });

  it("marks the taxonomy as a placeholder until H-402", async () => {
    await seed(db);
    const terms = await db.taxonomyTerm.findMany();
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(term.label).toContain("placeholder until H-402");
    }
  });

  it("creates no users and no tracks", async () => {
    await seed(db);
    await expect(db.user.count()).resolves.toBe(0);
    await expect(db.track.count()).resolves.toBe(0);
  });
});
