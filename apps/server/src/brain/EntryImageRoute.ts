// `GET /api/threads/:threadId/entries/:entryId/images/:index`: the bytes of an image inside a
// transcript entry (a screenshot a tool returned, a pasted picture), which the thread stream
// replaces with a reference (ADR 0020). Entries never change, so a response is cached for good by
// the browser that asked, and never by anything shared. The guard in front of `/api` admits only
// the owner; there is no per-image signature. The media type comes from the transcript, which a
// tool wrote, so only png, jpeg, gif and webp are served inline; anything else is a download, and
// every answer carries a sandbox CSP (T24), as attachments do.

import { EntryId, NonNegativeInt, ThreadId } from "@cairn/protocol/Ids";
import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { problem } from "../http/Problem.ts";
import { HarnessSeam } from "./HarnessSeam.ts";

/** The route's path, as the router matches it. */
export const ENTRY_IMAGE_PATH =
  "/api/threads/:threadId/entries/:entryId/images/:index";

const Params = Schema.Struct({
  threadId: ThreadId,
  entryId: Schema.FiniteFromString.pipe(Schema.decodeTo(EntryId)),
  index: Schema.FiniteFromString.pipe(Schema.decodeTo(NonNegativeInt)),
});

/** The image types served inline; the transcript's media type is whatever a tool wrote. */
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** The headers and type an entry image is served with. */
export const entryImageHeaders = (mimeType: string) => {
  const inline = INLINE_IMAGE_TYPES.has(mimeType.toLowerCase());

  return {
    contentType: inline ? mimeType : "application/octet-stream",
    headers: {
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": inline ? "inline" : "attachment",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  };
};

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
        HttpServerResponse.uint8Array(
          image.bytes,
          entryImageHeaders(image.mimeType)
        )
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
