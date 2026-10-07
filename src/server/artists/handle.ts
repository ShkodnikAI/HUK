// Public identity rules for artist onboarding (H-209).
// Handles: lowercase [a-z0-9_-]{3,30}, reserved words refused, unique
// case-insensitively (a functional unique index in Postgres enforces the
// last word; the service pre-checks for a friendly error). Display names:
// any script, 1-60 chars, no control characters. Both go through the
// text check hook (a stub that always passes until H-204/H-208).

import { HttpError } from "@/server/http/errors";
import { textCheck } from "./text-check";

export const HANDLE_PATTERN = /^[a-z0-9_-]{3,30}$/;

/** Names no user may claim. Extendable; the list is deliberately short. */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  "admin", "administrator", "mod", "moderator", "api", "huk", "support",
  "help", "staff", "root", "security", "official", "login", "logout",
  "signin", "signup", "auth", "me", "self", "system", "radio", "charts",
]);

/** 422 when the handle violates the handle rules (H-209 task 4). */
export function validateHandle(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw handleError("handle must be 3-30 characters of a-z, 0-9, '_' or '-' (lowercase)");
  }
  if (RESERVED_HANDLES.has(handle)) {
    throw handleError("this handle is reserved");
  }
}

/** 422 when the display name violates the rules (any script, no controls). */
export function validateDisplayName(name: string): void {
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 60) {
    throw handleError("display name must be 1-60 characters");
  }
  // Control characters of every kind (Cc, Cf) are refused; any script is fine.
  if (/[\p{Cc}\p{Cf}]/u.test(trimmed)) {
    throw handleError("display name must not contain control characters");
  }
}

/** The single text-check hook application point for onboarding texts. */
export async function checkOnboardingTexts(handle: string, displayName: string): Promise<void> {
  validateHandle(handle);
  validateDisplayName(displayName);
  // Fail closed (S9): a checker that errors or says no keeps the text out.
  if (!(await textCheck(handle)) || !(await textCheck(displayName))) {
    throw handleError("text failed the moderation check");
  }
}

function handleError(message: string): HttpError {
  return new HttpError(422, "VALIDATION_FAILED", `Invalid fields: ${message}`);
}
