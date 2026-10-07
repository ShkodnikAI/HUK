// IP capture and hashing (H-103, S7): a raw client IP is read from exactly
// one configured header and only ever stored as a salted, daily-rotating
// HMAC — never persisted as such.

import { createHmac } from "node:crypto";
import { DEV_DEFAULTS, type Env } from "@/server/env";

/**
 * Reads the client IP from the single configured header.
 * x-forwarded-for is never trusted unless it IS the configured header.
 */
export function clientIp(req: Request, env: Env): string | null {
  const headerName = env.CLIENT_IP_HEADER ?? DEV_DEFAULTS.CLIENT_IP_HEADER;
  const value = req.headers.get(headerName);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Salted hash of `<UTC date>:<ip>` with IP_HASH_SALT, hex truncated to
 * 32 chars (16 bytes). The UTC date gives daily rotation without storing
 * salts; the raw IP is never recoverable and never part of the output.
 */
export function hashIp(ip: string, now: Date, env: Env): string {
  const salt = env.IP_HASH_SALT ?? DEV_DEFAULTS.IP_HASH_SALT;
  const day = now.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  return createHmac("sha256", salt).update(`${day}:${ip}`).digest("hex").slice(0, 32);
}
