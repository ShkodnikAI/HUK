import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  buildReportActionRequest,
  buildTrackActionRequest,
  performRequest,
} from "@/components/mod/actions";
import { TranscriptExcerpt } from "@/components/mod/transcript-excerpt";

// H-207: a component-level contract test per action. The buttons glue to
// these pure builders/performers, so each action is tested for the exact
// request it sends to the existing APIs (client-side level), and the
// transcript guarantee is tested at the rendered-HTML level.

describe("H-207 track actions build the right API requests", () => {
  it("APPROVE posts to /api/mod/tracks/resolve without a reason", () => {
    const built = buildTrackActionRequest({ action: "APPROVE", trackId: "t1" });
    expect(built.url).toBe("/api/mod/tracks/resolve");
    expect(built.method).toBe("POST");
    expect(JSON.parse(built.body)).toEqual({ trackId: "t1", action: "APPROVE" });
  });

  it("REJECT carries the mandatory reason", () => {
    const built = buildTrackActionRequest({ action: "REJECT", trackId: "t1", reason: "stolen recording" });
    expect(JSON.parse(built.body)).toEqual({ trackId: "t1", action: "REJECT", reason: "stolen recording" });
  });

  it("RESTRICT carries reason and the country code", () => {
    const built = buildTrackActionRequest({ action: "RESTRICT", trackId: "t1", reason: "court order", countryCode: "DE" });
    expect(JSON.parse(built.body)).toEqual({ trackId: "t1", action: "RESTRICT", reason: "court order", countryCode: "DE" });
  });
});

describe("H-207 report actions build the right API requests", () => {
  it("DISMISS posts to /api/mod/reports/resolve with the statement of reasons", () => {
    const built = buildReportActionRequest({ action: "DISMISS", reportId: "r1", statementOfReasons: "no violation" });
    expect(built.url).toBe("/api/mod/reports/resolve");
    expect(JSON.parse(built.body)).toEqual({ reportId: "r1", action: "DISMISS", statementOfReasons: "no violation" });
  });

  it("TAKEDOWN carries the statement of reasons", () => {
    const built = buildReportActionRequest({ action: "TAKEDOWN", reportId: "r1", statementOfReasons: "confirmed copy" });
    expect(JSON.parse(built.body)).toEqual({ reportId: "r1", action: "TAKEDOWN", statementOfReasons: "confirmed copy" });
  });

  it("RESTRICT carries the statement and the country code", () => {
    const built = buildReportActionRequest({ action: "RESTRICT", reportId: "r1", statementOfReasons: "legal order", countryCode: "FR" });
    expect(JSON.parse(built.body)).toEqual({ reportId: "r1", action: "RESTRICT", statementOfReasons: "legal order", countryCode: "FR" });
  });

  it("BAN carries the statement and the duration in days", () => {
    const built = buildReportActionRequest({ action: "BAN", reportId: "r2", statementOfReasons: "serial harasser", banDays: 14 });
    expect(JSON.parse(built.body)).toEqual({ reportId: "r2", action: "BAN", statementOfReasons: "serial harasser", banDays: 14 });
  });
});

describe("H-207 performRequest maps outcomes honestly", () => {
  it("sends POST with JSON content type and reports ok on 2xx", async () => {
    const calls: Array<{ url: string; init: { method: string; body: string; headers: Record<string, string> } }> = [];
    const doFetch = async (url: string, init: { method: string; body: string; headers: Record<string, string> }) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    };
    const result = await performRequest(buildTrackActionRequest({ action: "APPROVE", trackId: "t1" }), doFetch);
    expect(result).toEqual({ ok: true, status: 200 });
    expect(calls[0].url).toBe("/api/mod/tracks/resolve");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
  });

  it("a 403 guard failure surfaces as ok:false (the console shows it, never retries silently)", async () => {
    const doFetch = async () => new Response("{}", { status: 403 });
    const result = await performRequest(buildTrackActionRequest({ action: "APPROVE", trackId: "t1" }), doFetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });
});

describe("H-207 transcript renders as text, never as HTML (S5)", () => {
  it("markup in a transcript is escaped, not executed", () => {
    const hostile = '<script>alert(1)</script> & <b>bold</b> \u2014 untrusted';
    const html = renderToString(createElement(TranscriptExcerpt, { text: hostile }));
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("long transcripts are truncated deterministically", () => {
    const html = renderToString(createElement(TranscriptExcerpt, { text: "x".repeat(500), maxLength: 400 }));
    expect(html).toContain("[truncated]");
  });
});
