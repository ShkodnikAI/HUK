// @vitest-environment jsdom
// H-120 task 7: shell and component contracts + axe accessibility runs.
import axe from "axe-core";
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BottomNav, TopNav } from "@/components/shell/Nav";
import { QuietState } from "@/components/shell/QuietState";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { TextArea, TextField } from "@/components/ui/TextField";
import { renderWithMessages } from "./helpers";

afterEach(() => cleanup());

async function expectNoAxeViolations(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, { resultTypes: ["violations"] });
  const serious = result.violations.filter((v) => (v.impact ?? "") !== "minor");
  expect(serious.map((v) => `${v.id}: ${v.nodes.length} nodes`)).toEqual([]);
}

describe("navigation (H-120 task 3)", () => {
  it("renders only ENABLED items — search, playlists and me do not exist yet", () => {
    renderWithMessages(
      <>
        <TopNav />
        <BottomNav />
      </>,
    );
    // Both bars render; scope the assertions per landmark.
    const bars = screen.getAllByRole("navigation");
    for (const bar of bars) {
      expect(within(bar).getByRole("link", { name: "Radio" })).toBeTruthy();
      expect(within(bar).getByRole("link", { name: "Charts" })).toBeTruthy();
      expect(within(bar).queryByRole("link", { name: "Search" })).toBeNull();
      expect(within(bar).queryByRole("link", { name: "Playlists" })).toBeNull();
      expect(within(bar).queryByRole("link", { name: "Me" })).toBeNull();
    }
  });

  it("marks the active destination with aria-current (both bars)", () => {
    // jsdom pathname defaults to "/" — the radio item is active.
    renderWithMessages(
      <>
        <TopNav />
        <BottomNav />
      </>,
    );
    const topNav = screen.getByRole("navigation", { name: "Main" });
    const bottomNav = screen.getByRole("navigation", { name: "Main navigation" });
    expect(within(topNav).getByRole("link", { name: "Radio" }).getAttribute("aria-current")).toBe("page");
    expect(within(topNav).getByRole("link", { name: "Charts" }).getAttribute("aria-current")).toBeNull();
    expect(within(bottomNav).getByRole("link", { name: "Radio" }).getAttribute("aria-current")).toBe("page");
  });

  it("every navigation link carries the 44 px minimum tap-target classes", () => {
    renderWithMessages(<BottomNav />);
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toMatch(/min-h-\[44px\]/);
      expect(link.className).toMatch(/min-w-\[44px\]/);
    }
  });
});

describe("base components (H-120 task 4)", () => {
  it("Button: primary keeps the 48 px minimum, secondary and ghost the 44 px one", () => {
    renderWithMessages(
      <>
        <Button>go</Button>
        <Button variant="secondary">go</Button>
        <Button variant="ghost">go</Button>
      </>,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons[0].className).toMatch(/min-h-\[48px\]/);
    expect(buttons[1].className).toMatch(/min-h-\[44px\]/);
    expect(buttons[2].className).toMatch(/min-h-\[44px\]/);
    for (const button of buttons) expect(button.className).toMatch(/focus-gold/);
  });

  it("StatusBadge always renders a word (children are required and shown)", () => {
    renderWithMessages(<StatusBadge tone="success">On air</StatusBadge>);
    const badge = screen.getByText("On air");
    expect(badge.textContent).toBe("On air");
    expect(badge.className).toMatch(/bg-success-bg/);
  });

  it("TextField wires label, help and error with aria-describedby and aria-invalid", () => {
    renderWithMessages(
      <TextField label="Track title" helpText="Visible to everyone" errorText="Title is required" />,
    );
    const input = screen.getByLabelText("Track title");
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy).not.toBe("");
    for (const id of describedBy.split(" ")) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Title is required");
  });

  it("TextArea wires the same contract", () => {
    renderWithMessages(<TextArea label="Lyrics" helpText="Optional" rows={3} />);
    const area = screen.getByLabelText("Lyrics");
    const describedBy = area.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(describedBy)?.textContent).toBe("Optional");
  });

  it("Chip renders its text", () => {
    renderWithMessages(<Chip>ambient</Chip>);
    expect(screen.getByText("ambient")).toBeTruthy();
  });

  it("QuietState announces itself and carries the word + text", () => {
    renderWithMessages(<QuietState />);
    expect(screen.getByRole("status").textContent).toContain("The station is silent");
  });
});

describe("accessibility (axe, H-120 done criteria)", () => {
  it("the shell navigation and a component sample have no axe violations", async () => {
    const { container } = renderWithMessages(
      <>
        <TopNav />
        <BottomNav />
        <Button>primary</Button>
        <Button variant="secondary">secondary</Button>
        <TextField label="Email" helpText="We send a link, never a password" />
        <TextArea label="Lyrics" />
        <Chip>ambient</Chip>
        <StatusBadge tone="success">On air</StatusBadge>
        <QuietState />
      </>,
    );
    await expectNoAxeViolations(container);
  });

  it("the 404 page has a heading, a link home and no axe violations", async () => {
    const NotFound = (await import("@/app/[locale]/not-found")).default;
    const { container } = renderWithMessages(<NotFound />);
    expect(screen.getByRole("heading")).toBeTruthy();
    const home = screen.getByRole("link", { name: "Back to the radio" });
    expect(home.getAttribute("href")).toBe("/");
    await expectNoAxeViolations(container);
  });
});
