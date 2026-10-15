// H-123 task 7 (DB integration): the lyrics column end to end —
// submission stores normalised lyrics, the PATCH route answers by actor
// (owner 200, other artist 404, non-artist 403, anonymous 401), the audit
// row carries the length only, /api/tracks/mine is the one owner door for
// non-APPROVED lyrics, no public read route ever carries lyrics, and the
// env-driven cap is honoured. DATABASE_URL unset → the suite is skipped
// (it runs in CI).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { PrismaClient } from "@prisma/client";
import { SESSION_COOKIE } from "@/server/guard";
import { createDefaultLoader } from "@/server/net/safe-fetch";
import type { SafeLoader } from "@/server/net/safe-fetch";
import { cleanTables, databaseUrl, makeClient } from "./helpers";

describe.skipIf(!databaseUrl)("artist lyrics (H-123)", () => {
  const db = makeClient();
  const realLoader = createDefaultLoader();

  const audioBytes = Buffer.from("fake-audio-bytes");
  let server: { port: number; close: () => Promise<void> };

  const localLoader: SafeLoader = async (req) => {
    const localUrl = new URL(`http://127.0.0.1:${server.port}${req.url.pathname}${req.url.search}`);
    return realLoader({ ...req, url: localUrl, pinnedAddress: "127.0.0.1", headers: { ...req.headers, host: req.headers.host } });
  };
  const seam = () => ({
    loader: localLoader,
    resolver: async () => ["93.184.216.34"],
    portAllowlist: [443, server.port],
    client: db as never,
  });

  const validSubmission = {
    title: "With Lyrics",
    source: { provider: "DIRECT_URL", url: "https://author-host.test/track.mp3" },
    rightsOwned: true,
    aiGenerated: false,
    humanContribution: "vocals by me",
    language: "en",
    instrumental: false,
    licenseScope: "RADIO_ONLY",
    tosVersion: "0.0-draft",
  };

  beforeAll(async () => {
    server = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.method === "HEAD") {
          res.writeHead(200, { etag: '"t1"', "content-length": String(audioBytes.byteLength) });
          res.end();
          return;
        }
        res.writeHead(200, { "content-length": String(audioBytes.byteLength) });
        res.end(audioBytes);
      });
      s.listen(0, "127.0.0.1", () =>
        resolve({ port: (s.address() as { port: number }).port, close: () => new Promise<void>((r) => s.close(() => r())) }),
      );
    });
  });

  beforeEach(async () => {
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    await cleanTables(db);
  });

  afterEach(async () => {
    await cleanTables(db);
  });

  afterAll(async () => {
    await server.close();
    await db.$disconnect();
  });

  async function artist(emailPrefix: string): Promise<{ id: string }> {
    const u = await db.user.create({ data: { email: `${emailPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.example`, role: "ARTIST" } });
    await db.artistProfile.create({ data: { userId: u.id, handle: `${emailPrefix}-${Math.floor(Math.random() * 1e9)}`, displayName: "Artist" } });
    await db.session.create({ data: { userId: u.id, sessionToken: `tok-${u.id}`, expires: new Date(Date.now() + 86_400_000) } });
    return u;
  }

  async function submitFor(user: { id: string }, overrides: Record<string, unknown> = {}): Promise<string> {
    const { submitTrack } = await import("@/server/tracks/submit");
    const { loadEnv } = await import("@/server/env");
    const result = await submitTrack(
      user.id,
      null,
      { ...validSubmission, ...overrides } as never,
      loadEnv(),
      seam() as never,
    );
    return result.trackId;
  }

  function patchRequest(user: { id: string } | null, trackId: string, body: unknown): Promise<Response> {
    return import("@/app/api/tracks/[id]/lyrics/route").then(({ PATCH }) =>
      PATCH(
        new Request(`http://localhost:3000/api/tracks/${trackId}/lyrics`, {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            origin: "http://localhost:3000",
            ...(user ? { cookie: `${SESSION_COOKIE}=tok-${user.id}` } : {}),
          },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: trackId }) },
      ),
    );
  }

  it("submission stores normalised lyrics (CRLF folded, trimmed) on the created track", async () => {
    const u = await artist("lyr-a");
    const trackId = await submitFor(u, { lyrics: "  first\r\nliné  " });
    const track = await db.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.lyrics).toBe("first\nliné");
    // A submission without lyrics stores NULL.
    const plainId = await submitFor(u, { title: "Plain", lyrics: undefined, source: { provider: "DIRECT_URL", url: "https://author-host.test/b.mp3" } });
    const plain = await db.track.findUniqueOrThrow({ where: { id: plainId } });
    expect(plain.lyrics).toBeNull();
  });

  it("submission with lyrics that carry a link answers 422 LYRICS_LINK_FORBIDDEN and creates nothing", async () => {
    const u = await artist("lyr-b");
    await expect(submitFor(u, { lyrics: "find me at example.com" })).rejects.toMatchObject({
      status: 422,
      code: "LYRICS_LINK_FORBIDDEN",
    });
    expect(await db.track.count()).toBe(0);
  });

  it("submission with control characters in lyrics answers 422 LYRICS_FORBIDDEN_CHARS", async () => {
    const u = await artist("lyr-c");
    await expect(submitFor(u, { lyrics: "bad\u0000lyric" })).rejects.toMatchObject({
      status: 422,
      code: "LYRICS_FORBIDDEN_CHARS",
    });
  });

  it("the env-driven cap is honoured: LYRICS_MAX_CHARS=10 refuses an 11-character text", async () => {
    const u = await artist("lyr-d");
    process.env.LYRICS_MAX_CHARS = "10";
    try {
      await expect(submitFor(u, { lyrics: "a".repeat(11) })).rejects.toMatchObject({
        status: 422,
        code: "LYRICS_TOO_LONG",
      });
    } finally {
      delete process.env.LYRICS_MAX_CHARS;
    }
  });

  it("the owner edits lyrics on their own track: 200, row updated, audit row with the length only", async () => {
    const u = await artist("lyr-e");
    const trackId = await submitFor(u);
    const res = await patchRequest(u, trackId, { lyrics: "my own\r\nwords" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { track: { lyrics: string | null; lyricsLength: number | null } };
    expect(body.track.lyrics).toBe("my own\nwords");
    expect(body.track.lyricsLength).toBe("my own\nwords".length);
    const track = await db.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.lyrics).toBe("my own\nwords");
    // The audit row carries the length, never the text.
    const audits = await db.auditLog.findMany({ where: { action: "track.lyrics.edit", targetId: trackId } });
    expect(audits).toHaveLength(1);
    const payload = JSON.stringify(audits[0].payload);
    expect(payload).not.toContain("my own");
    expect(payload).toContain('"lyricsLength"');
  });

  it("removing lyrics sends null, stores null and audits lyricsLength null", async () => {
    const u = await artist("lyr-f");
    const trackId = await submitFor(u, { lyrics: "to be removed" });
    const res = await patchRequest(u, trackId, { lyrics: null });
    expect(res.status).toBe(200);
    const track = await db.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.lyrics).toBeNull();
    const audits = await db.auditLog.findMany({ where: { action: "track.lyrics.edit", targetId: trackId } });
    expect(JSON.stringify(audits[0].payload)).toContain('"lyricsLength":null');
  });

  it("another artist's track answers 404 and stays unchanged", async () => {
    const owner = await artist("lyr-g");
    const stranger = await artist("lyr-h");
    const trackId = await submitFor(owner, { lyrics: "owner words" });
    const res = await patchRequest(stranger, trackId, { lyrics: "hijacked" });
    expect(res.status).toBe(404);
    const track = await db.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.lyrics).toBe("owner words");
  });

  it("a non-artist (LISTENER) answers 403; an anonymous caller answers 401", async () => {
    const owner = await artist("lyr-i");
    const listener = await db.user.create({ data: { email: `listener-${Date.now()}@test.example`, role: "LISTENER" } });
    await db.session.create({ data: { userId: listener.id, sessionToken: `tok-${listener.id}`, expires: new Date(Date.now() + 86_400_000) } });
    const trackId = await submitFor(owner);
    expect((await patchRequest(listener, trackId, { lyrics: "x" })).status).toBe(403);
    expect((await patchRequest(null, trackId, { lyrics: "x" })).status).toBe(401);
  });

  it("an invalid lyrics body answers 422 with the typed code and the row is untouched", async () => {
    const u = await artist("lyr-j");
    const trackId = await submitFor(u, { lyrics: "good words" });
    const res = await patchRequest(u, trackId, { lyrics: "go to example.com now" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("LYRICS_LINK_FORBIDDEN");
    const track = await db.track.findUniqueOrThrow({ where: { id: trackId } });
    expect(track.lyrics).toBe("good words");
  });

  it("the PATCH rate limit refuses after the 20th edit in the hour (fail closed)", async () => {
    const u = await artist("lyr-k");
    const trackId = await submitFor(u);
    let last = 200;
    for (let i = 0; i < 21; i++) {
      last = (await patchRequest(u, trackId, { lyrics: `edit number ${i}` })).status;
    }
    expect(last).toBe(429);
  });

  it("contract: lyrics of a non-APPROVED track reach only the owner (/api/tracks/mine); no public route carries lyrics", async () => {
    const u = await artist("lyr-l");
    const pendingId = await submitFor(u, { lyrics: "PENDING-SECRET-LYRICS" });
    const approvedId = await submitFor(u, { title: "Approved", lyrics: "APPROVED-PUBLIC-SOON-LYRICS", source: { provider: "DIRECT_URL", url: "https://author-host.test/c.mp3" } });
    await db.track.update({ where: { id: approvedId }, data: { status: "APPROVED" } });

    // The owner door returns the lyrics for every own status.
    const { GET } = await import("@/app/api/tracks/mine/route");
    const mineRes = await GET(
      new Request("http://localhost:3000/api/tracks/mine", { headers: { cookie: `${SESSION_COOKIE}=tok-${u.id}` } }),
      { params: Promise.resolve({}) },
    );
    const mineBody = JSON.stringify(await mineRes.json());
    expect(mineBody).toContain("PENDING-SECRET-LYRICS");
    expect(mineBody).toContain("APPROVED-PUBLIC-SOON-LYRICS");
    expect(mineBody).toContain('"lyricsMaxChars"');

    // Public reads: the radio feed (with the APPROVED track actually on
    // air) and the public comments thread never carry lyrics — the public
    // lyrics display is H-124, not this card.
    await db.broadcastSlot.create({
      data: { seq: 1n, trackId: approvedId, startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 60_000) },
    });
    const { GET: radioNow } = await import("@/app/api/radio/now/route");
    const radioBody = JSON.stringify(await (await radioNow(new Request("http://localhost:3000/api/radio/now"), undefined as never)).json());
    expect(radioBody).toContain("Approved"); // the track IS served...
    expect(radioBody).not.toContain("APPROVED-PUBLIC-SOON-LYRICS"); // ...without its lyrics
    expect(radioBody).not.toContain('"lyrics"');

    const { GET: comments } = await import("@/app/api/tracks/[id]/comments/route");
    const commentsRes = await comments(
      new Request(`http://localhost:3000/api/tracks/${approvedId}/comments`),
      { params: Promise.resolve({ id: approvedId }) },
    );
    expect(JSON.stringify(await commentsRes.json())).not.toContain("APPROVED-PUBLIC-SOON-LYRICS");
    expect(pendingId).toBeTruthy();
  });

  it("the mine route reports the server's own limits (used out of the cap, lyrics maximum)", async () => {
    const u = await artist("lyr-m");
    await submitFor(u);
    const { GET } = await import("@/app/api/tracks/mine/route");
    const res = await GET(
      new Request("http://localhost:3000/api/tracks/mine", { headers: { cookie: `${SESSION_COOKIE}=tok-${u.id}` } }),
      { params: Promise.resolve({}) },
    );
    const body = (await res.json()) as { limits: { dailySubmissionsUsed: number; dailySubmissionsCap: number; lyricsMaxChars: number } };
    expect(body.limits.dailySubmissionsUsed).toBe(1);
    expect(body.limits.dailySubmissionsCap).toBe(2);
    expect(body.limits.lyricsMaxChars).toBe(6000);
  });
});
