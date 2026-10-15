// @vitest-environment jsdom
// H-120 task 5: the offline banner appears and disappears on the browser
// online/offline events (no service worker involved).
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfflineBanner } from "@/components/shell/OfflineBanner";
import { renderWithMessages } from "./helpers";

afterEach(() => cleanup());

describe("offline banner (H-120 task 5)", () => {
  it("appears on the offline event and disappears on the online event", () => {
    renderWithMessages(<OfflineBanner />);
    expect(screen.queryByRole("status")).toBeNull(); // online by default

    act(() => {
      Object.defineProperty(window, "navigator", {
        value: { ...window.navigator, onLine: false },
        configurable: true,
      });
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByRole("status").textContent).toContain("offline");

    act(() => {
      Object.defineProperty(window, "navigator", {
        value: { ...window.navigator, onLine: true },
        configurable: true,
      });
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
