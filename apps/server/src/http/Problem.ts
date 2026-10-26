// The JSON error body the HTTP routes answer with, in the shape of the protocol's error codes:
// `code`, `message`, and whether trying again may help. Never cached.
import { HttpServerResponse } from "effect/http";

/** A JSON problem with `fields` beside the code and message (an upload's `reason`). */
export const problemWith = (
  status: number,
  code: string,
  message: string,
  fields: Readonly<Record<string, string | null>>
) =>
  HttpServerResponse.jsonUnsafe(
    { code, message, retryable: status >= 500, ...fields },
    { status, headers: { "cache-control": "no-store" } }
  );

/** A JSON problem: a 5xx is retryable, anything else is not. */
export const problem = (status: number, code: string, message: string) =>
  problemWith(status, code, message, {});
