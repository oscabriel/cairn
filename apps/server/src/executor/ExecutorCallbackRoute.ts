// `GET /oauth/executor/callback`: where Executor's consent page sends the browser back after a
// sign-in Cairn started (`executor.signIn`). The guard runs first, so only the owner's devices
// reach it; the OAuth `state` must be the one sign-in Cairn has in flight, once, within ten
// minutes. The answer is a small page that says what happened and links back to Cairn; the query
// (which carries a one-time code) is never logged.

import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { CALLBACK_PATH, ExecutorLink } from "./ExecutorLink.ts";

const Query = Schema.Struct({
  state: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(Schema.String),
  iss: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = (status: number, title: string, body: string) =>
  HttpServerResponse.text(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><main style="font:16px system-ui;margin:2rem;max-width:40rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p><p><a href="/">Back to Cairn</a></p></main>`,
    {
      status,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'",
        "referrer-policy": "no-referrer",
      },
    }
  );

/** Finishes an Executor sign-in from the OAuth redirect. */
export const ExecutorCallbackRoute = HttpRouter.add(
  "GET",
  CALLBACK_PATH,
  Effect.gen(function* () {
    const link = yield* ExecutorLink;

    const query = yield* HttpServerRequest.schemaSearchParams(Query).pipe(
      Effect.option
    );

    if (Option.isNone(query)) {
      return page(
        400,
        "Executor sign-in failed",
        "The sign-in answer was malformed. Start the sign-in again from Cairn's settings."
      );
    }

    const { value } = query;

    return yield* link
      .callback({
        state: Option.fromUndefinedOr(value.state),
        code: Option.fromUndefinedOr(value.code),
        iss: Option.fromUndefinedOr(value.iss),
        error: Option.fromUndefinedOr(value.error),
        errorDescription: Option.fromUndefinedOr(value.error_description),
      })
      .pipe(
        Effect.as(
          page(
            200,
            "Executor connected",
            "Cairn can use Executor again. You can close this page."
          )
        ),
        Effect.catchTag("ExecutorSignInError", (error) =>
          Effect.logWarning("Executor sign-in callback failed").pipe(
            Effect.annotateLogs({
              event: "executor_sign_in_failed",
              reason: error.reason,
            }),
            Effect.as(
              page(
                error.reason === "unknown_state" ? 400 : 502,
                "Executor sign-in failed",
                error.message
              )
            )
          )
        )
      );
  })
);
