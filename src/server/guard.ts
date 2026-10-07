// Central authorization guard (H-102, H-110; S1). Route handlers call
// requireSession/requireUser/requireRole; fail closed on any error.
// Identity comes only from the server-side session (database strategy).

import type { Role, Session, User } from "@prisma/client";
import { HttpError } from "@/server/http/errors";
import { loadEnv } from "@/server/env";
import { db } from "@/server/db";

export const SESSION_COOKIE = "next-auth.session-token";
export const SECURE_SESSION_COOKIE = "__Secure-next-auth.session-token";

function readSessionToken(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;
    const value = rest.join("=");
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * F12 (H-110): mutating requests (everything except GET/HEAD) must carry an
 * `Origin` or `Referer` header whose host matches the host of NEXTAUTH_URL.
 * Session cookies are SameSite=Lax, this is the second door (CSRF defense in
 * depth); mismatch or absence is a 403 BAD_ORIGIN — fail closed (S9).
 */
function assertSameOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const expected = new URL(loadEnv().NEXTAUTH_URL).host;
  const raw = req.headers.get("origin") ?? req.headers.get("referer");
  if (!raw) {
    throw new HttpError(403, "BAD_ORIGIN", "Missing Origin header");
  }
  let host: string | null = null;
  try {
    host = new URL(raw).host;
  } catch {
    host = null; // unparseable Origin/Referer is a mismatch
  }
  if (host !== expected) {
    throw new HttpError(403, "BAD_ORIGIN", "Cross-origin request rejected");
  }
}

/**
 * 401 without a valid session; 403 for banned or deleted users.
 * Fail closed: any unexpected error while resolving the session → 401.
 */
export async function requireSession(
  req: Request,
): Promise<{ session: Session; user: User }> {
  try {
    assertSameOrigin(req);
    const token = readSessionToken(req);
    if (!token) throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    const session = await db.session.findUnique({
      where: { sessionToken: token },
      include: { user: true },
    });
    if (!session || session.expires.getTime() <= Date.now()) {
      throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
    }
    if (session.user.deletedAt) {
      throw new HttpError(403, "ACCOUNT_DELETED", "Account no longer exists");
    }
    if (session.user.bannedUntil && session.user.bannedUntil.getTime() > Date.now()) {
      throw new HttpError(403, "BANNED", "Account is banned");
    }
    return { session, user: session.user };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Fail closed (S1): resolution errors deny access.
    throw new HttpError(401, "UNAUTHENTICATED", "Sign in required");
  }
}

/** 401 without a session; 403 for banned or deleted users. */
export async function requireUser(req: Request): Promise<{ user: User }> {
  const { user } = await requireSession(req);
  return { user };
}

/**
 * 403 unless the user holds one of the roles. ADMIN satisfies MODERATOR
 * (the platform treats ADMIN as a superset of moderation powers).
 * H-110 (F7): roles are the Prisma `Role` enum — a typo fails to compile
 * instead of silently denying.
 */
export async function requireRole(
  req: Request,
  ...roles: Role[]
): Promise<{ user: User }> {
  const { user } = await requireUser(req);
  const allowed =
    roles.includes(user.role) || (roles.includes("MODERATOR") && user.role === "ADMIN");
  if (!allowed) {
    throw new HttpError(403, "FORBIDDEN", "Insufficient role");
  }
  return { user };
}
