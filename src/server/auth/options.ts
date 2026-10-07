// Auth.js (next-auth v4, stable) configuration (H-102).
// - Database sessions (the Session model): role changes and bans apply on the
//   next request, because every request re-reads the session and user rows.
// - Email magic link: dev prints the link to the console; production sends
//   SMTP via EMAIL_SERVER (required in production, S8) and never logs tokens.
// - Everything is built from loadEnv() — no direct process.env in src/.

import EmailProvider from "next-auth/providers/email";
import { PrismaAdapter } from "@next-auth/prisma-adapter";
import type { NextAuthOptions } from "next-auth";
import type { PrismaClient } from "@prisma/client";
import { createTransport } from "nodemailer";
import { audit } from "@/server/audit";
import { db as defaultDb } from "@/server/db";
import type { Env } from "@/server/env";

/** Sign-in rate limits (H-103 limiter); numbers live here, in one place. */
export const SIGNIN_LIMITS = {
  perIp: { limit: 20, windowSec: 60 * 60 },
  perEmail: { limit: 5, windowSec: 60 * 60 },
} as const;

/** Normalizes an email before lookup/limiting/hash (H-102). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isProd(env: Env): boolean {
  return env.NODE_ENV === "production";
}

export function makeAuthOptions(
  env: Env,
  db: PrismaClient = defaultDb,
): NextAuthOptions {
  return {
    adapter: PrismaAdapter(db),
    secret: env.AUTH_SECRET,
    session: {
      // Database sessions: bans and role changes apply immediately.
      strategy: "database",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    },
    providers: [
      EmailProvider({
        server: env.EMAIL_SERVER ?? "",
        from: env.EMAIL_FROM,
        async sendVerificationRequest({ identifier, url }) {
          const email = normalizeEmail(identifier);
          if (isProd(env)) {
            // Production: SMTP, never log the URL/token (H-102).
            const transport = createTransport(env.EMAIL_SERVER as string);
            await transport.sendMail({
              to: email,
              from: env.EMAIL_FROM,
              subject: "HUK sign-in link",
              text: `Sign in to HUK:\n${url}`,
            });
            return;
          }
          // Development/test: print the link; never in production.
          console.log(`[auth] magic link for ${email}: ${url}`);
        },
      }),
    ],
    cookies: {
      sessionToken: {
        name: isProd(env) ? "__Secure-next-auth.session-token" : "next-auth.session-token",
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: isProd(env),
        },
      },
    },
    events: {
      // First-admin bootstrap (H-102): while no ADMIN exists, the verified
      // email from INITIAL_ADMIN_EMAIL becomes ADMIN on first sign-in.
      async signIn({ user }) {
        if (!env.INITIAL_ADMIN_EMAIL) return;
        const email = normalizeEmail(user.email ?? "");
        if (email !== normalizeEmail(env.INITIAL_ADMIN_EMAIL)) return;
        const admin = await db.user.findFirst({ where: { role: "ADMIN" } });
        if (admin) return;
        if (!user.id) return;
        await db.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
        await audit({
          actorId: user.id,
          actorKind: "system",
          action: "auth.initial_admin_bootstrap",
          targetType: "User",
          targetId: user.id,
          payload: { email },
        });
      },
    },
  };
}
