// @vitest-environment jsdom
// H-123 task 7: the cabinet — the five statuses as words with their badge
// tones, the statement of reasons, the server-reported quota line, the
// inline lyrics editor over the PATCH route (save, remove, cancel, the
// 422 codes in words) and the axe accessibility run.
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CabinetView } from "@/app/[locale]/cabinet/CabinetView";
import en from "../../messages/en.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/cabinet",
  useSearchParams: () => new URLSearchParams(),
}));

type Handler = { match: (url: string, method: string) => boolean; respond: () => Response };

function stubFetch(handlers: Handler[], calls: Array<{ url: string; method: string; body: unknown }> = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      for (const h of handlers) {
        if (h.match(url, method)) return h.respond();
      }
      return new Response(JSON.stringify({ error: { code: "NOT_MOCKED", message: url } }), { status: 404 });
    }),
  );
}

const TRACKS = [
  {
    id: "t-approved",
    title: "On Air Song",
    status: "APPROVED",
    createdAt: "2026-10-15T10:00:00.000Z",
    licenseScope: "RADIO_AND_PLAYLISTS",
    lyrics: "la la la",
    likes: 4,
    statementOfReasons: null,
  },
  {
    id: "t-pending",
    title: "Review Song",
    status: "PENDING",
    createdAt: "2026-10-15T11:00:00.000Z",
    licenseScope: "RADIO_ONLY",
    lyrics: null,
    likes: 0,
    statementOfReasons: null,
  },
  {
    id: "t-rejected",
    title: "Rejected Song",
    status: "REJECTED",
    createdAt: "2026-10-15T12:00:00.000Z",
    licenseScope: "RADIO_ONLY",
    lyrics: null,
    likes: 0,
    statementOfReasons: "the source link did not answer",
  },
  {
    id: "t-paused",
    title: "Paused Song",
    status: "SUSPENDED",
    createdAt: "2026-10-15T13:00:00.000Z",
    licenseScope: "RADIO_ONLY",
    lyrics: null,
    likes: 0,
    statementOfReasons: null,
  },
  {
    id: "t-removed",
    title: "Removed Song",
    status: "TAKEN_DOWN",
    createdAt: "2026-10-15T14:00:00.000Z",
    licenseScope: "RADIO_ONLY",
    lyrics: null,
    likes: 0,
    statementOfReasons: "removed after a report",
  },
];

function mineResponse(tracks = TRACKS, withLimits = true): Response {
  return new Response(
    JSON.stringify(
      withLimits
        ? { tracks, limits: { dailySubmissionsUsed: 1, dailySubmissionsCap: 2, lyricsMaxChars: 6000 } }
        : { tracks },
    ),
    { status: 200 },
  );
}

function renderCabinet(): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={en} now={new Date("2026-01-15T12:00:00Z")}>
      <CabinetView />
    </NextIntlClientProvider>,
  );
  return container;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the cabinet (H-123 task 5)", () => {
  it("every status is a word on a badge; the statement of reasons shows; no dislikes anywhere", async () => {
    stubFetch([{ match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse() }]);
    renderCabinet();
    await waitFor(() => expect(screen.getByText("On air")).toBeTruthy());
    expect(screen.getByText("In review")).toBeTruthy();
    expect(screen.getByText("Not accepted")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByText("Removed")).toBeTruthy();
    expect(screen.getByText("Reason: the source link did not answer")).toBeTruthy();
    expect(screen.getByText("Reason: removed after a report")).toBeTruthy();
    expect(screen.getByText("Waiting for a person to check it. The status here changes when the decision is made.")).toBeTruthy();
    expect(screen.getByText("Today 1 of 2 submissions used")).toBeTruthy();
    expect(screen.getByText("Dislikes are never shown to anyone, including you.")).toBeTruthy();
    // No statistics, no profile link, no external links (they belong to H-401).
    expect(screen.queryByText(/Likes/)).toBeNull();
    expect(screen.queryByText(/Public profile/)).toBeNull();
    expect(screen.queryByText(/Listens/)).toBeNull();
  });

  it("omits the quota line when the API does not expose it", async () => {
    stubFetch([{ match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse(TRACKS, false) }]);
    renderCabinet();
    await waitFor(() => expect(screen.getByText("On air")).toBeTruthy());
    expect(screen.queryByText(/submissions used/)).toBeNull();
  });

  it("the empty list shows the honest empty state and the Submit button links to the form", async () => {
    stubFetch([{ match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse([]) }]);
    renderCabinet();
    await waitFor(() => expect(screen.getByText("No tracks yet. Submit your first track with the button above.")).toBeTruthy());
    const submit = screen.getByRole("link", { name: "Submit" });
    expect(submit.getAttribute("href")).toBe("/en/submit");
  });

  it("Edit lyrics opens the inline editor pre-filled; saving PATCHes the text and reloads", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    let lyrics = "la la la";
    stubFetch(
      [
        {
          match: (url, m) => url.includes("/api/tracks/mine") && m === "GET",
          respond: () =>
            new Response(
              JSON.stringify({
                tracks: TRACKS.map((t) => (t.id === "t-approved" ? { ...t, lyrics } : t)),
                limits: { dailySubmissionsUsed: 0, dailySubmissionsCap: 2, lyricsMaxChars: 6000 },
              }),
              { status: 200 },
            ),
        },
        {
          match: (url, m) => url.includes("/lyrics") && m === "PATCH",
          respond: () => {
            lyrics = "new words";
            return new Response(JSON.stringify({ track: { id: "t-approved", lyrics, lyricsLength: 9 } }), { status: 200 });
          },
        },
      ],
      calls,
    );
    renderCabinet();
    await waitFor(() => expect(screen.getAllByText("Edit lyrics")[0]).toBeTruthy());
    fireEvent.click(screen.getAllByText("Edit lyrics")[0]);
    const editor = await waitFor(() => screen.getByLabelText("Lyrics (your own words, plain text)"));
    expect((editor as HTMLTextAreaElement).value).toBe("la la la");
    // The current lyrics are visible as plain text before editing.
    expect(screen.getByText("la la la")).toBeTruthy();
    fireEvent.change(editor, { target: { value: "new words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save lyrics" }));
    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toEqual({ lyrics: "new words" });
      expect(patch?.url).toBe("/api/tracks/t-approved/lyrics");
    });
    // The reload happens (the GET runs again) and the editor closes.
    await waitFor(() => expect(screen.queryByLabelText("Lyrics (your own words, plain text)")).toBeNull());
  });

  it("Remove lyrics sends null; Cancel closes without a request", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch(
      [
        { match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse() },
        { match: (url, m) => url.includes("/lyrics") && m === "PATCH", respond: () => new Response(JSON.stringify({ track: { id: "t-approved", lyrics: null } }), { status: 200 }) },
      ],
      calls,
    );
    renderCabinet();
    await waitFor(() => expect(screen.getAllByText("Edit lyrics")[0]).toBeTruthy());
    fireEvent.click(screen.getAllByText("Edit lyrics")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    fireEvent.click(screen.getAllByText("Edit lyrics")[0]);
    fireEvent.click(screen.getByRole("button", { name: "Remove lyrics" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ lyrics: null }));
  });

  it("a lyrics PATCH refusal shows the code in words (link forbidden, rate limited)", async () => {
    for (const [code, message] of [
      ["LYRICS_LINK_FORBIDDEN", "Lyrics cannot contain links or addresses. Remove them and try again."],
      ["RATE_LIMITED", "Too many attempts. Wait a little and try again."],
    ] as const) {
      cleanup();
      stubFetch([
        { match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse() },
        {
          match: (url, m) => url.includes("/lyrics") && m === "PATCH",
          respond: () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status: 422 }),
        },
      ]);
      renderCabinet();
      await waitFor(() => expect(screen.getAllByText("Edit lyrics")[0]).toBeTruthy());
      fireEvent.click(screen.getAllByText("Edit lyrics")[0]);
      fireEvent.click(screen.getByRole("button", { name: "Save lyrics" }));
      await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    }
  });

  it("no axe violations with the list rendered and the editor open", async () => {
    stubFetch([{ match: (url, m) => url.includes("/api/tracks/mine") && m === "GET", respond: () => mineResponse() }]);
    const container = renderCabinet();
    await waitFor(() => expect(screen.getByText("On air")).toBeTruthy());
    fireEvent.click(screen.getAllByText("Edit lyrics")[0]);
    await waitFor(() => expect(screen.getByLabelText("Lyrics (your own words, plain text)")).toBeTruthy());
    const result = await axe.run(container, { resultTypes: ["violations"] });
    expect(result.violations.filter((v) => (v.impact ?? "") !== "minor").map((v) => v.id)).toEqual([]);
  });
});
