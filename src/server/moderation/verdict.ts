// Verdict parse layer (H-204): the LLM output must parse against the policy's
// output contract; anything else (malformed JSON, wrong types, out-of-range
// confidence) fails closed to null and the stage ends in REVIEW (S9). Extra
// keys are ignored (zod strips them by default).

import { z } from "zod";

export const verdictSchema = z.object({
  verdict: z.enum(["APPROVE", "REJECT", "REVIEW"]),
  confidence: z.number().min(0).max(1),
  categories: z.array(z.string().min(1).max(64)).max(16),
  summary: z.string().max(2000),
});

export type ParsedVerdict = z.infer<typeof verdictSchema>;

/**
 * Accepts a bare JSON object, optionally wrapped in one markdown code fence.
 * Returns null for anything that does not parse or violates the schema —
 * the caller maps null to REVIEW (fail closed).
 */
export function parseVerdict(raw: string | null | undefined): ParsedVerdict | null {
  if (raw === null || raw === undefined) return null;
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fence) text = fence[1].trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = verdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
