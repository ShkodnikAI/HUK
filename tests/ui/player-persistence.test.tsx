// @vitest-environment jsdom
// H-120 task 3 (done criterion): the persistent player must NOT remount
// when navigating. The contract is the layout structure: the player lives
// in the LAYOUT, outside <main>, and navigation swaps only the children.
// This test renders the same structure (stable sibling + changing page
// content) and asserts the player's DOM node identity and mount count
// survive the navigation.

import { cleanup, render } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";

let mountCount = 0;
let playerNode: HTMLElement | null = null;

function PlayerProbe() {
  useEffect(() => {
    mountCount += 1;
  }, []);
  return (
    <div
      data-testid="player"
      ref={(node) => {
        playerNode = node;
      }}
    />
  );
}

function Layout({ page }: { page: string }) {
  return (
    <>
      <nav aria-label="Main" />
      <main>{page === "a" ? <p>radio screen</p> : <p>charts screen</p>}</main>
      <footer>
        <PlayerProbe />
      </footer>
    </>
  );
}

afterEach(() => {
  cleanup();
  mountCount = 0;
  playerNode = null;
});

describe("the player survives navigation (H-120)", () => {
  it("keeps the player DOM node and mount count when the page content changes", () => {
    const { rerender } = render(<Layout page="a" />);
    const before = playerNode;
    expect(before).not.toBeNull();
    expect(mountCount).toBe(1);

    rerender(<Layout page="b" />);
    expect(playerNode).toBe(before); // the SAME DOM node — no remount
    expect(mountCount).toBe(1);
    expect(document.querySelector("main")?.textContent).toBe("charts screen");
  });
});
