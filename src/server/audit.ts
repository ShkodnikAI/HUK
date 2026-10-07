// Audit writer (H-103): append-only trail into AuditLog. Payloads are
// sanitised (sensitive keys dropped, long strings truncated) before they are
// stored — audit must never become a side channel for secrets.

import type { Prisma } from "@prisma/client";
import { db } from "@/server/db";

const SENSITIVE_KEY = /token|secret|password|authorization|cookie|email/i;
const MAX_STRING_LENGTH = 2048;

/** Recursively drops sensitive keys and truncates long strings. */
export function sanitizePayload(
  value: unknown,
  maxStringLength: number = MAX_STRING_LENGTH,
): Prisma.InputJsonValue {
  return sanitize(value, maxStringLength, 0) as Prisma.InputJsonValue;
}

function sanitize(value: unknown, maxStringLength: number, depth: number): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") {
    return value.length > maxStringLength
      ? `${value.slice(0, maxStringLength)}…[truncated ${value.length} chars]`
      : value;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, maxStringLength, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue; // dropped, not masked — never stored
    out[key] = sanitize(item, maxStringLength, depth + 1);
  }
  return out;
}

export type AuditEntry = {
  actorId?: string;
  actorKind: string; // "user" | "worker" | "ai"
  action: string;
  targetType?: string;
  targetId?: string;
  payload?: unknown;
};

/** Writes one AuditLog row with a sanitised payload. */
export async function audit(entry: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      actorId: entry.actorId,
      actorKind: entry.actorKind,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      payload: entry.payload === undefined ? {} : sanitizePayload(entry.payload),
    },
  });
}
