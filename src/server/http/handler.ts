// Route wrapper (H-103): request id, typed error mapping and an optional
// rate limit, applied uniformly. Route handlers stay thin (AGENTS §7).

import { randomUUID } from "node:crypto";
import { errorResponse } from "./errors";
import { tooManyRequests } from "@/server/ratelimit";

export type RateLimitOptions = { key: string; limit: number; windowSec: number };

export type RouteOptions = { rateLimit?: RateLimitOptions };

export function route<TCtx>(
  handler: (req: Request, ctx: TCtx) => Promise<Response> | Response,
  opts?: RouteOptions,
): (req: Request, ctx: TCtx) => Promise<Response> {
  return async (req, ctx) => {
    const requestId = randomUUID();
    try {
      if (opts?.rateLimit) {
        const verdict = await (await import("@/server/ratelimit")).rateLimit(opts.rateLimit);
        if (!verdict.ok) {
          return tooManyRequests(verdict.retryAfterSec, requestId);
        }
      }
      const res = await handler(req, ctx);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
