// Typed HTTP errors and the shared error response format (H-103).
// Every error body is `{ error: { code, message, requestId } }`; unexpected
// errors collapse to a generic 500 — no stack, no PII in the body.

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export function errorBody(code: string, message: string, requestId: string) {
  return { error: { code, message, requestId } };
}

/** Maps any thrown value to a Response; logs unexpected errors with the request id. */
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof HttpError) {
    return Response.json(errorBody(error.code, error.message, requestId), {
      status: error.status,
      headers: { "x-request-id": requestId },
    });
  }
  // Unexpected: log server-side (with stack), answer with a generic body.
  console.error(`[http] unhandled error requestId=${requestId}`, error);
  return Response.json(errorBody("INTERNAL", "Internal server error", requestId), {
    status: 500,
    headers: { "x-request-id": requestId },
  });
}
