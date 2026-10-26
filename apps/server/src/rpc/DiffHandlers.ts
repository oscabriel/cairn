// `diff.turn` and `diff.full`: a thread's diffs between its checkpoint refs, through `Diffs`. A
// missing thread, a thread with no checkpoints (the scratch project, a folder that is not a git
// repository) and a turn never captured are `NotFound` with resource `checkpoint` or `thread`; a
// git or store failure is `Unavailable`, as a retry may succeed.

import { NotFound, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Option } from "effect";

import type { DiffError } from "../git/Diffs.ts";
import { Diffs } from "../git/Diffs.ts";

/** The protocol error a `DiffError` means. */
export const diffFailure = (
  failure: DiffError,
  requestId: Option.Option<string>
): NotFound | Unavailable =>
  failure.reason === "failed"
    ? new Unavailable({ message: failure.message, requestId })
    : new NotFound({
        message: failure.message,
        resource:
          failure.reason === "thread_not_found" ? "thread" : "checkpoint",
        id: failure.threadId,
        requestId,
      });

/** The diff handlers, to merge over the stubs in `rpc/Handlers.ts`. Needs `Diffs`. */
export const DiffHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "diff.turn",
      Diffs.useSync(
        (diffs) =>
          (input, { requestId }) =>
            diffs
              .turn(input)
              .pipe(
                Effect.mapError((failure) =>
                  diffFailure(failure, Option.some(String(requestId)))
                )
              )
      )
    ),
    CairnRpcs.toLayerHandler(
      "diff.full",
      Diffs.useSync(
        (diffs) =>
          (input, { requestId }) =>
            diffs
              .full(input)
              .pipe(
                Effect.mapError((failure) =>
                  diffFailure(failure, Option.some(String(requestId)))
                )
              )
      )
    )
  ),
};
