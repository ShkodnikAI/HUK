// Input parsing for route handlers (H-103). Every parse failure is a typed
// HttpError; validation failures expose field paths only — never the values.

import type { ZodType } from "zod";
import { HttpError } from "./errors";

export const DEFAULT_MAX_JSON_BYTES = 32 * 1024;

/** Parses the request body as JSON and validates it with zod. */
export async function parseJson<T>(
  req: Request,
  schema: ZodType<T>,
  opts?: { maxBytes?: number },
): Promise<T> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_JSON_BYTES;

  // F4 (H-110): reject by Content-Length before touching the stream.
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
  }

  // F4 (H-110): stream the body with a byte counter and cancel at the limit —
  // an oversized chunked body must not be buffered whole.
  if (!req.body) {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let raw = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    raw += decoder.decode(value, { stream: true });
    if (total > maxBytes) {
      await reader.cancel(); // stop pulling: never read the rest
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
    }
  }
  raw += decoder.decode();

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body is not valid JSON");
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new HttpError(422, "VALIDATION_FAILED", `Invalid fields: ${paths}`);
  }
  return parsed.data;
}

/** Validates URL query parameters with zod (422 on failure). */
export function parseQuery<T>(url: URL, schema: ZodType<T>): T {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new HttpError(422, "VALIDATION_FAILED", `Invalid query fields: ${paths}`);
  }
  return parsed.data;
}
