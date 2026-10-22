// `GET /api/threads/:threadId/entries/:entryId/images/:index`: the bytes of an image inside a
// transcript entry (a screenshot a tool returned, a pasted picture), which the thread stream
// replaces with a reference (ADR 0020). Entries never change, so a response is cached for good by
// the browser that asked, and never by anything shared. The guard in front of `/api` admits only
// the owner; there is no per-image signature.

import { EntryId, NonNegativeInt, ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { HarnessSeam } from "./HarnessSeam.ts";

/** The route's path, as the router matches it. */
export const ENTRY_IMAGE_PATH =
  "/api/threads/:threadId/entries/:entryId/images/:index";

const Params = Schema.Struct({
  threadId: ThreadId,
  entryId: Schema.FiniteFromString.pipe(Schema.decodeTo(EntryId)),
  index: Schema.FiniteFromString.pipe(Schema.decodeTo(NonNegativeInt)),
});

const problem = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { code, message },
    { status, headers: { "cache-control": "no-store" } }
  );

/** Serves one entry image through the harness seam. */
const entryImageResponse = (seam: HarnessSeam["Service"]) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.schemaPathParams(Params).pipe(
      Effect.option
    );

    if (Option.isNone(params)) {
      return problem(
        400,
        "invalid_input",
        "The image address is malformed: it needs a thread id, an entry id and an image index."
      );
    }

    const { entryId, index, threadId } = params.value;

    return yield* seam.entryImage(threadId, entryId, index).pipe(
      Effect.map((image) =>
        HttpServerResponse.uint8Array(image.bytes, {
          contentType: image.mimeType,
          headers: {
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        })
      ),
      Effect.catchTag("HarnessError", (failure) => {
        if (failure.reason === "unavailable") {
          return Effect.succeed(problem(503, "unavailable", failure.message));
        }

        if (
          failure.reason === "thread_not_found" ||
          failure.reason === "entry_not_found"
        ) {
          return Effect.succeed(problem(404, "not_found", failure.message));
        }

        return Effect.succeed(problem(500, "internal", failure.message));
      })
    );
  });

/** The route, to register in `http/Routes.ts`; it takes the seam when the router is built. */
export const EntryImageRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;

    yield* router.add("GET", ENTRY_IMAGE_PATH, entryImageResponse(seam));
  })
);
