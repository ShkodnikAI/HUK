// Pure request builders and performers for the moderator console actions
// (H-207, H-303). Every console action goes through the EXISTING APIs:
//   - track decisions      → POST /api/mod/tracks/resolve (H-207)
//   - report resolutions   → POST /api/mod/reports/resolve (H-206)
//   - comment decisions    → POST /api/mod/comments/:id (H-303)
// The builders are pure so each action has a per-action contract test; the
// components glue them to buttons and refresh the page afterwards.

export type TrackActionInput =
  | { action: "APPROVE"; trackId: string }
  | { action: "REJECT"; trackId: string; reason: string }
  | { action: "RESTRICT"; trackId: string; reason: string; countryCode: string };

export type ReportActionInput =
  | { action: "DISMISS"; reportId: string; statementOfReasons: string }
  | { action: "TAKEDOWN"; reportId: string; statementOfReasons: string }
  | { action: "RESTRICT"; reportId: string; statementOfReasons: string; countryCode: string }
  | { action: "BAN"; reportId: string; statementOfReasons: string; banDays: number };

export type CommentActionInput =
  | { action: "APPROVE"; commentId: string }
  | { action: "HIDE"; commentId: string; reason: string }
  | { action: "REMOVE"; commentId: string; reason: string };

export type BuiltRequest = { url: string; method: "POST"; body: string };

export function buildTrackActionRequest(input: TrackActionInput): BuiltRequest {
  const url = "/api/mod/tracks/resolve";
  if (input.action === "APPROVE") {
    return { url, method: "POST", body: JSON.stringify({ trackId: input.trackId, action: "APPROVE" }) };
  }
  if (input.action === "REJECT") {
    return { url, method: "POST", body: JSON.stringify({ trackId: input.trackId, action: "REJECT", reason: input.reason }) };
  }
  return {
    url,
    method: "POST",
    body: JSON.stringify({ trackId: input.trackId, action: "RESTRICT", reason: input.reason, countryCode: input.countryCode }),
  };
}

export function buildReportActionRequest(input: ReportActionInput): BuiltRequest {
  const url = "/api/mod/reports/resolve";
  if (input.action === "RESTRICT") {
    return {
      url,
      method: "POST",
      body: JSON.stringify({
        reportId: input.reportId,
        action: "RESTRICT",
        statementOfReasons: input.statementOfReasons,
        countryCode: input.countryCode,
      }),
    };
  }
  if (input.action === "BAN") {
    return {
      url,
      method: "POST",
      body: JSON.stringify({
        reportId: input.reportId,
        action: "BAN",
        statementOfReasons: input.statementOfReasons,
        banDays: input.banDays,
      }),
    };
  }
  return {
    url,
    method: "POST",
    body: JSON.stringify({ reportId: input.reportId, action: input.action, statementOfReasons: input.statementOfReasons }),
  };
}

export function buildCommentActionRequest(input: CommentActionInput): BuiltRequest {
  return {
    url: `/api/mod/comments/${encodeURIComponent(input.commentId)}`,
    method: "POST",
    body: JSON.stringify(
      input.action === "APPROVE"
        ? { action: "APPROVE" }
        : { action: input.action, reason: input.reason },
    ),
  };
}

type SameOriginFetch = (url: string, init: { method: "POST"; body: string; headers: Record<string, string> }) => Promise<Response>;

const defaultFetch: SameOriginFetch = (url, init) =>
  fetch(url, { ...init, credentials: "same-origin" });

/** Performs a built request; JSON content type always. Client-side guard failures surface as ok:false. */
export async function performRequest(built: BuiltRequest, doFetch: SameOriginFetch = defaultFetch): Promise<ActionResult> {
  const res = await doFetch(built.url, {
    method: built.method,
    body: built.body,
    headers: { "content-type": "application/json" },
  });
  return { ok: res.ok, status: res.status };
}

export type ActionResult = { ok: boolean; status: number };
