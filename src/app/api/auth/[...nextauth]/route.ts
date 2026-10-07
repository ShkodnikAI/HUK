// Auth.js catch-all (H-102). GET passes through; POST goes through the
// sign-in rate limiter (per IP hash / per email hash, H-103 limiter).
// The options are built per request so that `next build` (no runtime env,
// H-107) never validates anything and env changes apply immediately.

import NextAuth from "next-auth";
import { makeAuthOptions } from "@/server/auth/options";
import { withSignInRateLimit } from "@/server/auth/signin-limit";
import { loadEnv } from "@/server/env";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ nextauth: string[] }> }): Promise<Response> {
  const handler = NextAuth(makeAuthOptions(loadEnv()));
  return handler(req as never, ctx as never);
}

export async function POST(req: Request, ctx: { params: Promise<{ nextauth: string[] }> }): Promise<Response> {
  return withSignInRateLimit(req, loadEnv(), async () => {
    const handler = NextAuth(makeAuthOptions(loadEnv()));
      return handler(req as never, ctx as never);
  });
}
