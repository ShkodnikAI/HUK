// Central authorization guard (H-102, S1). Route handlers call
// requireSession/requireUser/requireRole; fail closed on any error.
// Identity comes only from the server-side session (database strategy).

import type { Session, User } from "@prisma/client";
import { HttpError } from "@/server/http/errors";
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

/** Resolves the user of the request's session, or null (database sessions). */
export async function resolveUser(req: Request): Promise<User | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const session = await db.session.findUnique({
    where: { sessionToken: token },
    include: { user: true },
  });
  if (!session) return null;
  if (session.expires.getTime() <= Date.now()) return null;
  return session.user;
}

/**
 * 401 without a valid session; 403 for banned or deleted users.
 * Fail closed: any unexpected error while resolving the session → 401.
 */
export async function requireSession(
  req: Request,
): Promise<{ session: Session; user: User }> {
  try {
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
 */
export async function requireRole(
  req: Request,
  ...roles: string[]
): Promise<{ user: User }> {
  const { user } = await requireUser(req);
  const allowed =
    roles.includes(user.role) || (roles.includes("MODERATOR") && user.role === "ADMIN");
  if (!allowed) {
    throw new HttpError(403, "FORBIDDEN", "Insufficient role");
  }
  return { user };
}
