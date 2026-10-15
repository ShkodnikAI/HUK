// @vitest-environment jsdom
// H-121 task 6: engine/view contracts — ONE <audio> element, navigation
// never interrupts playback, the private dislike renders no count, the
// radio screen is axe-clean and goes quiet when the station is silent.
import axe from "axe-core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerProvider } from "@/components/player/engine/PlayerEngine";
import { RadioScreen } from "@/components/player/RadioScreen";
import { MiniPlayer } from "@/components/player/MiniPlayer";
import { NextIntlClientProvider } from "next-intl";
import { messages } from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const NOW_BODY = {
  serverTime: Date.now(),
  current: {
    track: {
      id: "c1xxxxxxxxxxxxxxxxxxxxxxx",
      title: "Night City",
      artist: "Vera",
      durationSec: 180,
      audioUrl: "https://author.example/night.mp3",
      restrictedIn: [],
      likes: 7,
      language: "en",
      instrumental: false,
      aiGenerated: true,
    },
    startsAt: Date.now() - 10_000,
    endsAt: Date.now() + 170_000,
    offsetMs: 10_000,
  },
  next: [],
};

function mockFetch(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/radio/now")) {
      return new Response(JSON.stringify(NOW_BODY), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/api/geo")) {
      return new Response(JSON.stringify({ country: null }), { status: 200 });
    }
    if (url.includes("/api/me/reactions")) {
      return new Response(JSON.stringify({ reactions: [] }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }));
}

/** Message provider identical to helpers.renderWithMessages — local for the harness. */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages.en} now={new Date("2026-01-15T12:00:00Z")}>
      {children}
    </NextIntlClientProvider>
  );
}

/** Renders ui inside the message provider + the engine. */
function renderWithEngine(ui: React.ReactElement) {
  return render(
    <Providers>
      <PlayerProvider>{ui}</PlayerProvider>
    </Providers>,
  );
}

/** Renders ui inside the message provider + the engine, with a provider-aware rerender. */
function renderHarness(ui: React.ReactElement) {
  const first = render(
    <Providers>
      <PlayerProvider>{ui}</PlayerProvider>
    </Providers>,
  );
  return {
    ...first,
    navigateTo: (next: React.ReactElement): void => {
      // The layout keeps <PlayerProvider> mounted and swaps the children.
      first.rerender(
        <Providers>
          <PlayerProvider>{next}</PlayerProvider>
        </Providers>,
      );
    },
  };
}

describe("engine/view split (H-121 task 6)", () => {
  it("mounts exactly ONE <audio> element with the provider, whatever the views", () => {
    mockFetch();
    render(
      <Providers>
        <PlayerProvider>
          <RadioScreen />
          <MiniPlayer />
        </PlayerProvider>
      </Providers>,
    );
    expect(document.querySelectorAll("audio")).toHaveLength(1);
  });

  it("navigation between screens does not interrupt playback (same audio node, no re-play)", async () => {
    mockFetch();
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockReturnValue(undefined);

    const harness = renderHarness(<RadioScreen />);
    // Wait for the first /now poll to populate the timeline.
    await waitFor(() => expect(screen.getByText("Night City")).toBeTruthy());
    // Play via the big radio-screen control.
    const playButtons = screen.getAllByRole("button", { name: "Play" });
    await act(async () => {
      playButtons[0].click();
    });
    const audio = document.querySelector("audio");
    expect(audio).not.toBeNull();
    expect(playSpy).toHaveBeenCalledTimes(1);

    // "Navigate": the layout swaps the children — another screen instead.
    harness.navigateTo(<MiniPlayer />);
    const audioAfter = document.querySelector("audio");
    expect(audioAfter).toBe(audio); // the SAME element — no remount
    // Playback continues: pause was never called, play was not re-issued.
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalledTimes(1);
    // The mini player view shows what is on air.
    expect(screen.getByText(/Night City/)).toBeTruthy();
  });

  it("the private dislike renders NO count and no digits (only the like carries the public count)", async () => {
    mockFetch();
    renderWithEngine(
      <RadioScreen />,
    );
    await waitFor(() => expect(screen.getByText("Night City")).toBeTruthy());
    const dislike = screen.getByRole("button", { name: "Dislike (private)" });
    expect(dislike.textContent).not.toMatch(/\d/); // no count for anyone
    const like = screen.getByRole("button", { name: /Like/ });
    expect(like.textContent).toMatch(/7/); // the PUBLIC like count from /now
  });

  it("the radio screen has no axe violations", async () => {
    mockFetch();
    const { container } = renderWithEngine(
      <RadioScreen />,
    );
    await waitFor(() => expect(screen.getByText("Night City")).toBeTruthy());
    const result = await axe.run(container, { resultTypes: ["violations"] });
    const serious = result.violations.filter((v) => (v.impact ?? "") !== "minor");
    expect(serious.map((v) => v.id)).toEqual([]);
  });

  it("the QuietState renders when nothing is on air", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/radio/now")) {
        return new Response(JSON.stringify({ serverTime: Date.now(), current: null, next: [] }), { status: 200 });
      }
      if (url.includes("/api/geo")) return new Response(JSON.stringify({ country: null }), { status: 200 });
      return new Response("{}", { status: 200 });
    }));
    renderWithEngine(
      <RadioScreen />,
    );
    await waitFor(() => expect(screen.getByText("The station is silent")).toBeTruthy());
  });
});
