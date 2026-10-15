// @vitest-environment jsdom
// H-123 task 7: the submit form — the server-reported limits and counter,
// the field mapping of every API error the form can receive, the
// provisional rights wording (no terms link, no bracketed note), the
// instrumental rule and the axe accessibility run.
import axe from "axe-core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubmitView } from "@/app/[locale]/submit/SubmitView";
import en from "../../messages/en.json";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  usePathname: () => "/submit",
  useSearchParams: () => new URLSearchParams(),
}));

const LANGUAGES = Object.entries(en.taxonomy.language).map(([slug, label]) => ({ slug, label }));
const LIMITS = { dailySubmissionsUsed: 1, dailySubmissionsCap: 2, lyricsMaxChars: 6000 };

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

function mineHandler(status = 200): Handler {
  return {
    match: (url, method) => url.includes("/api/tracks/mine") && method === "GET",
    respond: () => new Response(JSON.stringify({ tracks: [], limits: LIMITS }), { status }),
  };
}

function renderForm(): HTMLElement {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={en} now={new Date("2026-01-15T12:00:00Z")}>
      <SubmitView languages={LANGUAGES} tosVersion="0.0-draft" />
    </NextIntlClientProvider>,
  );
  return container;
}

function fillValidForm(): void {
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My Song" } });
  fireEvent.change(screen.getByLabelText("Link to the audio file (https)"), { target: { value: "https://host.test/song.mp3" } });
  fireEvent.change(screen.getByLabelText("What did you do yourself? (lyrics, melody, arrangement, edits)"), {
    target: { value: "wrote and recorded it" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "I made this track or have the right to broadcast it." }));
}

async function submitForm(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Submit for checking" }));
  // The success path navigates away (busy stays set); every other path
  // re-enables the button. Either outcome leaves the POST recorded.
  await waitFor(
    () =>
      expect(
        (screen.getByRole("button", { name: "Submit for checking" }) as HTMLButtonElement).disabled === false || push.mock.calls.length > 0,
      ).toBe(true),
    { timeout: 2000 },
  );
}

beforeEach(() => {
  push.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the submit form (H-123 task 4)", () => {
  it("shows the server-reported limits and the lyrics counter (never hard-coded)", async () => {
    stubFetch([mineHandler()]);
    renderForm();
    await waitFor(() => expect(screen.getByText("Today: 1 of 2 submissions used")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    // Typing updates the counter.
    fireEvent.change(screen.getByLabelText("Add the words if you want listeners to read them"), {
      target: { value: "hello" },
    });
    expect(screen.getByText("5 / 6000")).toBeTruthy();
  });

  it("submits the full payload: the server constant tosVersion, no direction field, language from the curated set", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch([mineHandler(), { match: (url, m) => url.includes("/api/tracks") && m === "POST", respond: () => new Response(JSON.stringify({ track: { id: "t1" } }), { status: 201 }) }], calls);
    renderForm();
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Add the words if you want listeners to read them"), { target: { value: "my own words" } });
    await submitForm();
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeTruthy();
    const body = post!.body as Record<string, unknown>;
    expect(body.tosVersion).toBe("0.0-draft"); // read from the server constant prop
    expect(body.licenseScope).toBe("RADIO_AND_PLAYLISTS"); // the board default
    expect(body.instrumental).toBe(false);
    expect(body.language).toBe("en");
    expect(body.lyrics).toBe("my own words");
    expect(body.source).toEqual({ provider: "DIRECT_URL", url: "https://host.test/song.mp3" });
    expect(Object.keys(body)).not.toContain("direction");
    expect(Object.keys(body)).not.toContain("style");
    await waitFor(() => expect(push).toHaveBeenCalledWith("/en/cabinet"));
  });

  it("an instrumental track sends no language and disables the select", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    stubFetch([mineHandler(), { match: (url, m) => url.includes("/api/tracks") && m === "POST", respond: () => new Response(null, { status: 201 }) }], calls);
    renderForm();
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    fillValidForm();
    const instrumental = screen.getByRole("checkbox", { name: "Instrumental (no vocals)" });
    fireEvent.click(instrumental);
    expect((screen.getByLabelText("Language of lyrics") as HTMLSelectElement).disabled).toBe(true);
    await submitForm();
    const body = calls.find((c) => c.method === "POST")!.body as Record<string, unknown>;
    expect(body.instrumental).toBe(true);
    expect(body.language).toBeUndefined();
  });

  it("client-side required fields block the submit and mark the fields", async () => {
    stubFetch([mineHandler()]);
    renderForm();
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Submit for checking" }));
    await waitFor(() => expect(screen.getAllByText("Fill in this field.").length).toBeGreaterThanOrEqual(2));
  });

  it("SOURCE_UNREACHABLE lands on the url field", async () => {
    stubFetch([
      mineHandler(),
      {
        match: (url, m) => url.includes("/api/tracks") && m === "POST",
        respond: () => new Response(JSON.stringify({ error: { code: "SOURCE_UNREACHABLE", message: "x" } }), { status: 422 }),
      },
    ]);
    renderForm();
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    fillValidForm();
    await submitForm();
    expect(screen.getByText("The link did not answer. Check the address — the file must be reachable right now.")).toBeTruthy();
  });

  it("LYRICS_LINK_FORBIDDEN and LYRICS_TOO_LONG land on the lyrics field", async () => {
    for (const [code, message] of [
      ["LYRICS_LINK_FORBIDDEN", "Lyrics cannot contain links or addresses. Remove them and try again."],
      ["LYRICS_TOO_LONG", "The lyrics are too long. Shorten them and try again."],
    ] as const) {
      cleanup();
      stubFetch([
        mineHandler(),
        {
          match: (url, m) => url.includes("/api/tracks") && m === "POST",
          respond: () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status: 422 }),
        },
      ]);
      renderForm();
      await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
      fillValidForm();
      await submitForm();
      expect(screen.getByText(message)).toBeTruthy();
    }
  });

  it("QUOTA_EXCEEDED explains the wait; RATE_LIMITED and unknown codes map to their messages", async () => {
    for (const [code, message] of [
      ["QUOTA_EXCEEDED", "The daily limit is reached. The count resets at midnight UTC — try again tomorrow."],
      ["RATE_LIMITED", "Too many attempts. Wait a little and try again."],
      ["SOMETHING_NEW", "The submission failed. Try again; if it keeps failing, the platform may be unavailable."],
    ] as const) {
      cleanup();
      stubFetch([
        mineHandler(),
        {
          match: (url, m) => url.includes("/api/tracks") && m === "POST",
          respond: () => new Response(JSON.stringify({ error: { code, message: "x" } }), { status: code === "RATE_LIMITED" ? 429 : 422 }),
        },
      ]);
      renderForm();
      await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
      fillValidForm();
      await submitForm();
      expect(screen.getByText(message)).toBeTruthy();
    }
  });

  it("the rights wording is the provisional string without a terms link and without the bracketed legal note", () => {
    stubFetch([mineHandler()]);
    renderForm();
    const rights = screen.getByText("I made this track or have the right to broadcast it.");
    expect(rights.querySelector("a")).toBeNull();
    expect(screen.queryByText(/legal review/i)).toBeNull();
    expect(screen.queryByText(/\[/)).toBeNull();
  });

  it("no axe violations (empty and filled, with errors shown)", async () => {
    stubFetch([
      mineHandler(),
      {
        match: (url, m) => url.includes("/api/tracks") && m === "POST",
        respond: () => new Response(JSON.stringify({ error: { code: "SOURCE_UNREACHABLE", message: "x" } }), { status: 422 }),
      },
    ]);
    const container = renderForm();
    await waitFor(() => expect(screen.getByText("0 / 6000")).toBeTruthy());
    const empty = await axe.run(container, { resultTypes: ["violations"] });
    expect(empty.violations.filter((v) => (v.impact ?? "") !== "minor").map((v) => v.id)).toEqual([]);
    fillValidForm();
    fireEvent.change(screen.getByLabelText("Add the words if you want listeners to read them"), { target: { value: "words" } });
    await submitForm();
    const withError = await axe.run(container, { resultTypes: ["violations"] });
    expect(withError.violations.filter((v) => (v.impact ?? "") !== "minor").map((v) => v.id)).toEqual([]);
  });
});
