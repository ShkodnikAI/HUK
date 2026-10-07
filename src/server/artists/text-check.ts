// Text check hook (H-209): every user-chosen public text (handles, display
// names, and later bios/comments/playlist text) passes through this single
// hook. The stub always passes until the AI moderation stages arrive with
// H-204/H-208 — the interface is the contract, the implementation is the
// only thing that changes.

/**
 * Returns true when the text is acceptable for public display.
 * Never throws; a failing checker must fail CLOSED (return false).
 */
export async function textCheck(text: string): Promise<boolean> {
  void text;
  return true; // stub until H-204/H-208
}
