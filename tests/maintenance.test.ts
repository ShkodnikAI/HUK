import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanTables, databaseUrl, makeClient, skipMessage } from "./db/helpers";
import { makeMaintenanceJobs } from "@/server/maintenance/jobs";
import { startMaintenance, type MaintenanceJob } from "@/server/maintenance/runner";
import type { PrismaClient } from "@prisma/client";

// H-210 contract tests (S7): retention and housekeeping jobs remove exactly
// the expired rows and nothing else, are idempotent (a second run is a
// no-op), preserve verdict/cost when stripping transcripts, never overlap,
// respect batch limits, and audit their counts.

if (!databaseUrl) console.log(skipMessage());

const d = (ms: number) => new Date(Date.now() + ms);
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!databaseUrl)("maintenance jobs (H-210, S7)", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = makeClient();
    await cleanTables(client);
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
    process.env.DATABASE_URL ??= databaseUrl;
  });

  afterEach(async () => {
    await cleanTables(client);
    await client.$disconnect();
  });

  async function track() {
    return client.track.create({ data: { title: "t", status: "APPROVED", durationSec: 60 } });
  }

  async function job(name: string): Promise<string> {
    const jobs = makeMaintenanceJobs(client, { listenBatchSize: 10, transcriptBatchSize: 10, auditBatchSize: 10 });
    const j = jobs.find((x) => x.name === name);
    expect(j, `job ${name} must exist`).toBeTruthy();
    return j!.run();
  }

  it("purge-rate-limit-buckets removes only expired buckets and is a no-op on rerun", async () => {
    await client.rateLimitBucket.createMany({
      data: [
        { key: "old", windowStart: new Date(Date.now() - 2 * 60 * 60 * 1000), count: 5 },
        // A window that has not ended yet survives (windowStart < now is the
        // expiry rule shared with purgeExpiredBuckets in ratelimit.ts).
        { key: "fresh", windowStart: new Date(Date.now() + 60 * 1000), count: 1 },
      ],
    });
    const summary = await job("purge-rate-limit-buckets");
    expect(summary).toContain("1");
    expect(await client.rateLimitBucket.count()).toBe(1);
    expect((await client.rateLimitBucket.findFirst())!.key).toBe("fresh");
    // Second run: no-op.
    expect(await job("purge-rate-limit-buckets")).toContain("0");
    expect(await client.rateLimitBucket.count()).toBe(1);
  });

  it("purge-expired-sessions removes expired sessions and tokens only", async () => {
    const user = await client.user.create({ data: { email: "m@test.example" } });
    await client.session.createMany({
      data: [
        { userId: user.id, sessionToken: "expired", expires: new Date(Date.now() - 1000) },
        { userId: user.id, sessionToken: "live", expires: d(DAY) },
      ],
    });
    await client.verificationToken.createMany({
      data: [
        { identifier: "a@b.c", token: "old-token", expires: new Date(Date.now() - 1000) },
        { identifier: "a@b.c", token: "new-token", expires: d(DAY) },
      ],
    });
    const summary = await job("purge-expired-sessions");
    expect(summary).toContain("1 sessions, 1 verification tokens");
    expect(await client.session.count()).toBe(1);
    expect(await client.verificationToken.count()).toBe(1);
    expect(await job("purge-expired-sessions")).toContain("0 sessions, 0 verification tokens");
  });

  it("aggregate-listen-events preserves counts (sum before = sum of aggregates) and is idempotent", async () => {
    process.env.RETENTION_LISTEN_EVENTS_DAYS = "1"; // shrink the window for the test
    const t = await track();
    // 4 events on two DISTINCT UTC days, safely inside the (1 day) window.
    const day1 = new Date(Date.now() - 6 * DAY);
    day1.setUTCHours(1, 0, 0, 0);
    const day2 = new Date(Date.now() - 5 * DAY);
    day2.setUTCHours(23, 0, 0, 0);
    await client.listenEvent.createMany({
      data: [
        { trackId: t.id, mode: "RADIO", msListened: 1000, completed: true, skippedEarly: false, createdAt: day1 },
        { trackId: t.id, mode: "RADIO", msListened: 500, completed: false, skippedEarly: true, createdAt: day1 },
        { trackId: t.id, mode: "PLAYLIST", msListened: 250, completed: false, skippedEarly: false, createdAt: day2 },
        { trackId: t.id, mode: "RADIO", msListened: 250, completed: true, skippedEarly: false, createdAt: day2 },
        // A fresh event inside the retention window must survive untouched.
        { trackId: t.id, mode: "RADIO", msListened: 10, completed: false, skippedEarly: false, createdAt: new Date() },
      ],
    });
    const summary = await job("aggregate-listen-events");
    expect(summary).toContain("4 listen events");
    expect(await client.listenEvent.count()).toBe(1);

    const aggs = await client.listenAggregate.findMany({ orderBy: { day: "asc" } });
    expect(aggs).toHaveLength(2);
    const totalPlays = aggs.reduce((s, a) => s + a.plays, 0);
    const totalMs = aggs.reduce((s, a) => s + Number(a.msListened), 0);
    const totalCompletions = aggs.reduce((s, a) => s + a.completions, 0);
    const totalSkips = aggs.reduce((s, a) => s + a.skips, 0);
    expect(totalPlays).toBe(4);
    expect(totalMs).toBe(2000);
    expect(totalCompletions).toBe(2);
    expect(totalSkips).toBe(1);

    // Second run: no-op (nothing left inside the window boundary).
    expect(await job("aggregate-listen-events")).toContain("0 listen events");
    expect((await client.listenAggregate.findMany()).length).toBe(2);
  });

  it("aggregate respects the batch limit; successive runs drain the backlog exactly once", async () => {
    process.env.RETENTION_LISTEN_EVENTS_DAYS = "1";
    const t = await track();
    const old = new Date(Date.now() - 5 * DAY);
    const rows = Array.from({ length: 15 }, (_, i) => ({
      trackId: t.id,
      mode: "RADIO" as const,
      msListened: 10,
      createdAt: new Date(old.getTime() + i * 1000),
    }));
    await client.listenEvent.createMany({ data: rows });

    // This client's jobs use listenBatchSize 10 (see makeMaintenanceJobs call above).
    expect(await job("aggregate-listen-events")).toContain("10 listen events");
    expect(await client.listenEvent.count()).toBe(5);
    expect(await job("aggregate-listen-events")).toContain("5 listen events");
    expect(await client.listenEvent.count()).toBe(0);
    expect(await job("aggregate-listen-events")).toContain("0 listen events");
    const aggs = await client.listenAggregate.findMany();
    expect(aggs.reduce((s, a) => s + a.plays, 0)).toBe(15);
  });

  it("purge-transcripts strips transcript text but keeps verdict and cost fields", async () => {
    process.env.RETENTION_TRANSCRIPTS_DAYS = "1";
    const t = await track();
    // Distinct createdAt values so the orderBy below is deterministic.
    const old1 = new Date(Date.now() - 5 * DAY);
    const old2 = new Date(Date.now() - 5 * DAY + 1000);
    await client.moderationRun.createMany({
      data: [
        {
          trackId: t.id,
          stage: "ASR",
          verdict: "PASS",
          confidence: 0.9,
          costMicroUsd: 300,
          policyVersion: "draft-1",
          payload: { transcript: "very long old transcript text", provider: "mock" },
          createdAt: old1,
        },
        {
          trackId: t.id,
          stage: "POLICY",
          verdict: "REVIEW",
          confidence: 0.4,
          costMicroUsd: 100,
          payload: { summary: "kept summary" },
          createdAt: old2,
        },
        {
          trackId: t.id,
          stage: "ASR",
          verdict: "REVIEW",
          costMicroUsd: 50,
          payload: { transcript: "fresh transcript", provider: "mock" },
        },
      ],
    });
    const summary = await job("purge-transcripts");
    expect(summary).toContain("1 moderation payloads");
    const runs = await client.moderationRun.findMany({ orderBy: { createdAt: "asc" } });
    const stripped = runs[0].payload as Record<string, unknown>;
    expect(stripped).not.toHaveProperty("transcript");
    expect(stripped.provider).toBe("mock"); // non-transcript payload keys survive
    expect(runs[0].verdict).toBe("PASS"); // verdict kept
    expect(runs[0].costMicroUsd).toBe(300); // cost kept
    expect(runs[0].confidence).toBe(0.9);
    expect((runs[1].payload as Record<string, unknown>).summary).toBe("kept summary");
    expect((runs[2].payload as Record<string, unknown>).transcript).toBe("fresh transcript"); // inside window
    // Idempotent: rerun strips nothing new.
    expect(await job("purge-transcripts")).toContain("0 moderation payloads");
  });

  it("purge-audit-log removes only rows older than 24 months", async () => {
    const ancient = new Date(Date.now() - 25 * 30 * DAY);
    const recent = new Date(Date.now() - 1 * DAY);
    await client.auditLog.createMany({
      data: [
        { actorKind: "worker", action: "old.entry", createdAt: ancient },
        { actorKind: "worker", action: "new.entry", createdAt: recent },
      ],
    });
    const summary = await job("purge-audit-log");
    expect(summary).toContain("1 audit entries");
    expect(await client.auditLog.count()).toBe(1);
    expect((await client.auditLog.findFirst())!.action).toBe("new.entry");
    expect(await job("purge-audit-log")).toContain("0 audit entries");
  });
});

describe.skipIf(!databaseUrl)("maintenance runner (H-210)", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = makeClient();
    await cleanTables(client);
    process.env.AUTH_SECRET ??= "test-only fixture value, not a credential";
  });

  afterEach(async () => {
    await cleanTables(client);
    await client.$disconnect();
    vi.restoreAllMocks();
  });

  it("jobs do not overlap even when a job is slow; every run is audited with the summary", async () => {
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const slowJob: MaintenanceJob = {
      name: "slow-job",
      everyMs: 50,
      run: async () => {
        runs++;
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 120));
        active--;
        return `${runs} slow passes`;
      },
    };
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    const runner = startMaintenance({ jobs: [slowJob], tickMs: 10 });
    await new Promise((r) => setTimeout(r, 400));
    await runner.stop();
    expect(maxActive).toBe(1); // never overlapping
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes("[maintenance] slow-job:"))).toBe(true);
    // One AuditLog entry per run, carrying the summary.
    const auditRows = await client.auditLog.findMany({ where: { action: "maintenance.slow-job" } });
    expect(auditRows.length).toBe(runs);
    expect((auditRows[0].payload as Record<string, unknown>).summary).toContain("slow passes");
    // After stop: no more runs.
    const runsAtStop = runs;
    await new Promise((r) => setTimeout(r, 150));
    expect(runs).toBe(runsAtStop);
  });

  it("a failing job is logged loudly and does not stop the runner", async () => {
    const errorSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls = 0;
    const badJob: MaintenanceJob = {
      name: "bad-job",
      everyMs: 30,
      run: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return "recovered";
      },
    };
    const runner = startMaintenance({ jobs: [badJob], tickMs: 10 });
    await new Promise((r) => setTimeout(r, 120));
    await runner.stop();
    expect(calls).toBeGreaterThanOrEqual(2); // it retried after the failure
    errorSpy.mockRestore();
  });
});
