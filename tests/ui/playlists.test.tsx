// @vitest-environment jsdom
// H-121 task 6: the playlists screen states — guest empty state, empty
// list, the 409 limit in the user's language, and unavailable items
// marked in words. All API calls are mocked; the component contract is
// the thing under test.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// The playlists view navigates via the app router — not mounted in jsdom.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerProvider } from "@/components/player/engine/PlayerEngine";
import { PlaylistsView } from "@/app/[locale]/playlists/PlaylistsView";
import { renderWithMessages } from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonFetch(routes: Array<{ match: (url: string, method: string) => boolean; body: () => unknown; status?: number }>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      for (const route of routes) {
        if (route.match(url, method)) {
          return new Response(JSON.stringify(route.body()), {
            status: route.status ?? 200,
            headers: { "content-type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: { code: "NOT_MOCKED", message: url } }), { status: 404 });
    }),
  );
}

describe("playlists screen states (H-121 task 5)", () => {
  it("a guest listener sees the honest empty state (no playlists for anonymous)", async () => {
    jsonFetch([{ match: (url) => url.includes("/api/playlists"), body: () => ({}), status: 401 }]);
    renderWithMessages(
      <PlayerProvider>
        <PlaylistsView />
      </PlayerProvider>,
    );
    await waitFor(() => expect(screen.getByText("Playlists live in your account. Sign in to keep yours across devices.")).toBeTruthy());
  });

  it("an empty library shows the empty state", async () => {
    jsonFetch([{ match: (url) => url.includes("/api/playlists") && !url.includes("/api/playlists/"), body: () => ({ playlists: [] }) }]);
    renderWithMessages(
      <PlayerProvider>
        <PlaylistsView />
      </PlayerProvider>,
    );
    await waitFor(() => expect(screen.getByText("No playlists yet — create the first one above.")).toBeTruthy());
  });

  it("the 50-playlist limit is reported in the user's language when the API answers 409", async () => {
    jsonFetch([
      {
        match: (url, method) => url.endsWith("/api/playlists") && method === "GET",
        body: () => ({ playlists: Array.from({ length: 50 }, (_, i) => ({ id: `p${i}`, name: `pl ${i}`, itemCount: 0 })) }),
      },
      {
        match: (url, method) => url.endsWith("/api/playlists") && method === "POST",
        body: () => ({ error: { code: "PLAYLIST_LIMIT", message: "limit" } }),
        status: 409,
      },
    ]);
    renderWithMessages(
      <PlayerProvider>
        <PlaylistsView />
      </PlayerProvider>,
    );
    await waitFor(() => expect(screen.getByText("pl 49")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Playlist name"), { target: { value: "one more" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create playlist" }));
    });
    await waitFor(() => expect(screen.getByText("You already have the maximum number of playlists (50).")).toBeTruthy());
  });

  it("an unavailable item is marked in words and its controls stay usable", async () => {
    jsonFetch([
      {
        match: (url, method) => url.endsWith("/api/playlists") && method === "GET",
        body: () => ({ playlists: [{ id: "p1", name: "chill", itemCount: 2 }] }),
      },
      {
        match: (url) => url.includes("/api/playlists/p1") && !url.includes("items/"),
        body: () => ({
          id: "p1",
          name: "chill",
          visibility: "PRIVATE",
          items: [
            { trackId: "ta", position: 0, unavailable: false, title: "Fine Track" },
            { trackId: "tb", position: 1, unavailable: true },
          ],
        }),
      },
    ]);
    renderWithMessages(
      <PlayerProvider>
        <PlaylistsView />
      </PlayerProvider>,
    );
    await waitFor(() => expect(screen.getByText("chill")).toBeTruthy());
    await act(async () => {
      screen.getByRole("button", { name: /chill/ }).click();
    });
    await waitFor(() => expect(screen.getByText("Fine Track")).toBeTruthy());
    // The unavailable item: the WORD, not just styling.
    expect(screen.getByText("(unavailable)")).toBeTruthy();
  });
});
