// Ported from github.com/pingdotgg/t3code, apps/server/src/http.ts (`layerAttachmentUploadRoute`,
// lines 459 to 496) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: the route answers 200
// with the prepared `AttachmentRef` (not 204), so the chip is ready without a second call, every
// refusal is a JSON problem with a code and a reason, and the body goes through `AttachmentIntake`.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// `POST /api/attachments/upload/:token`: the raw bytes of one file, to the one-shot URL
// `attachments.createUploadUrl` signed. The guard (Host, identity, exact Origin) runs first as
// global middleware. A `Content-Length` other than the signed size is refused before the body is
// read; a chunked body is counted as it streams.

import { AttachmentRef } from "@cairn/protocol/Attachments";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Health } from "../http/Health.ts";
import { problemWith } from "../http/Problem.ts";
import { AttachmentIntake } from "./AttachmentIntake.ts";
import { UPLOAD_ROUTE_PREFIX, UploadTokens } from "./UploadTokens.ts";

/**
 * The route's path, as the router matches it. A wildcard, not `:token`: the router refuses path
 * parameters over 100 characters, and a signed token is about 260.
 */
export const UPLOAD_PATH = `${UPLOAD_ROUTE_PREFIX}/*`;

const noStore = { "cache-control": "no-store" };

const refJson = HttpServerResponse.schemaJson(
  Schema.toCodecJson(AttachmentRef)
);

const Params = Schema.Struct({ "*": Schema.String });

/** A refusal as JSON: a code a client switches on, the reason when there is one, and a message. */
const problem = (
  status: number,
  code: string,
  message: string,
  reason: Option.Option<string>
) => problemWith(status, code, message, { reason: Option.getOrNull(reason) });

const rejected = (status: number, reason: string, message: string) =>
  problem(status, "attachment_rejected", message, Option.some(reason));

const REJECTED_STATUS = {
  too_large: 413,
  unsupported_type: 415,
  unreadable: 415,
} as const;

/** The upload handler over the services it was built with. */
const receiveUpload = (
  tokens: UploadTokens["Service"],
  intake: AttachmentIntake["Service"],
  health: Health["Service"]
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;

    // Boot sweeps `attachments/.tmp`; an upload streaming into it meanwhile would lose its file.
    const ready = yield* health.isReady;

    if (!ready) {
      return problem(
        503,
        "unavailable",
        "Cairn is still starting, so the upload was not received. Try it again in a moment.",
        Option.none()
      );
    }

    const params = yield* HttpRouter.schemaPathParams(Params).pipe(
      Effect.option
    );

    if (Option.isNone(params)) {
      return problem(
        404,
        "not_found",
        "There is no upload at this address.",
        Option.none()
      );
    }

    const claims = yield* tokens.verify(params.value["*"]);
    const declared = request.headers["content-length"];

    if (declared !== undefined && Number(declared) !== claims.sizeBytes) {
      return rejected(
        400,
        "size_mismatch",
        `The upload of ${claims.name} is ${declared} bytes, but its URL was signed for ${String(claims.sizeBytes)}. Request a URL with the file's real size.`
      );
    }

    const ref = yield* intake.ingest(claims, request.stream);

    return yield* refJson(ref, { headers: noStore }).pipe(Effect.orDie);
  }).pipe(
    Effect.catchTags({
      UploadTokenRefused: (refused) =>
        Effect.succeed(
          refused.reason === "expired"
            ? rejected(400, "expired", refused.message)
            : problem(404, "not_found", refused.message, Option.none())
        ),
      UploadAlreadyReceived: (received) =>
        Effect.succeed(
          problem(409, "conflict", received.message, Option.none())
        ),
      UploadBodyMismatch: (mismatch) =>
        Effect.succeed(rejected(400, "size_mismatch", mismatch.message)),
      UploadRejected: (refused) =>
        Effect.succeed(
          rejected(
            REJECTED_STATUS[refused.reason],
            refused.reason,
            refused.message
          )
        ),
      IntakeUnavailable: (unavailable) =>
        Effect.succeed(
          problem(503, "unavailable", unavailable.message, Option.none())
        ),
      AttachmentStoreError: (failure) =>
        Effect.logError("attachment upload failed").pipe(
          Effect.annotateLogs({
            event: "attachment.upload_failed",
            operation: failure.operation,
          }),
          Effect.as(problem(500, "internal", failure.message, Option.none()))
        ),
    })
  );

/**
 * Receives one upload; register it in `http/Routes.ts`. It takes `UploadTokens`,
 * `AttachmentIntake` and `Health` (it refuses uploads until boot is done) when the router is built.
 */
export const UploadRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const tokens = yield* UploadTokens;
    const intake = yield* AttachmentIntake;
    const health = yield* Health;

    yield* router.add(
      "POST",
      UPLOAD_PATH,
      receiveUpload(tokens, intake, health)
    );
  })
);
