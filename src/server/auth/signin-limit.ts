// Sign-in rate limiting (H-102): the H-103 limiter applied to Auth.js email
// sign-in requests, keyed by hashed client IP and hashed (normalized) email.

import { clientIp, hashIp } from "@/server/iphash";
import { rateLimit, tooManyRequests } from "@/server/ratelimit";
import { SIGNIN_LIMITS, normalizeEmail } from "./options";
import type { Env } from "@/server/env";

/**
 * Limits POST /api/auth/signin/email: 20/hour per IP hash and 5/hour per
 * email hash. Returns a 429 response with Retry-After when either is
 * exceeded; otherwise the request proceeds.
 */
export async function withSignInRateLimit(
  req: Request,
  env: Env,
  proceed: () => Promise<Response>,
): Promise<Response> {
  const url = new URL(req.url);
  if (!url.pathname.endsWith("/signin/email")) {
    return proceed();
  }

  let email: string | null = null;
  try {
    // Clone: the underlying next-auth handler consumes the body itself.
    const form = await req.clone().formData();
    email = form.get("email")?.toString() ?? null;
  } catch {
    email = null;
  }
  if (email !== null) {
    // H-110 (F2): the normalizer is Auth.js-exact and throws on input Auth.js
    // would reject. Nothing gets mailed for such input, so the per-email
    // limiter key is skipped; the per-IP limit still applies.
    try {
      email = normalizeEmail(email);
    } catch {
      email = null;
    }
  }

  const ip = clientIp(req, env);
  const now = new Date();

  if (ip) {
    const ipVerdict = await rateLimit({
      key: `signin:ip:${hashIp(ip, now, env)}`,
      ...SIGNIN_LIMITS.perIp,
    });
    if (!ipVerdict.ok) return tooManyRequests(ipVerdict.retryAfterSec, "signin-ip");
  }

  if (email) {
    const emailVerdict = await rateLimit({
      key: `signin:email:${hashIp(email, now, env)}`,
      ...SIGNIN_LIMITS.perEmail,
    });
    if (!emailVerdict.ok) return tooManyRequests(emailVerdict.retryAfterSec, "signin-email");
  }

  return proceed();
}
