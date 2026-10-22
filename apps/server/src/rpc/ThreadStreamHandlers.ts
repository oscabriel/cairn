// The thread stream's RPCs: `thread.subscribe`, `thread.history`, `thread.entry` and
// `thread.retryTask`. Each is a thin call into the harness seam; this module only translates the
// seam's failures into the protocol's errors. Subagent conversations inside a thread arrive with
// subagents; until then a `conversationId` is refused as not found.

import { Internal, NotFound, Unavailable } from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type {
  EntryInput,
  HistoryInput,
  RetryTaskInput,
  SubscribeThreadInput,
} from "@cairn/protocol/Thread";
import { Effect, Layer, Option, Stream } from "effect";

import type { HarnessError } from "../brain/HarnessSeam.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";

/** The resource each seam "not found" names. */
const MISSING: Partial<Record<HarnessError["reason"], NotFound["resource"]>> = {
  thread_not_found: "thread",
  entry_not_found: "entry",
  task_not_found: "task",
  submission_not_found: "submission",
  approval_not_found: "approval",
};

/** A seam failure as the protocol's lookup errors say it. */
export const toLookupError = (
  failure: HarnessError,
  id: string
): NotFound | Unavailable | Internal => {
  const resource = MISSING[failure.reason];

  if (resource !== undefined) {
    return new NotFound({ message: failure.message, resource, id });
  }

  if (failure.reason === "unavailable") {
    return new Unavailable({ message: failure.message });
  }

  return new Internal({
    message: `The thread request failed inside the brain: ${failure.message}`,
  });
};

const noSubagents = (threadId: string) =>
  new NotFound({
    message: `Conversations inside thread ${threadId} are not served yet; subscribe to the thread itself.`,
    resource: "thread",
    id: threadId,
  });

/** The four handlers, for the handler group and for tests that call them directly. */
export const threadStreamHandlers = Effect.gen(function* () {
  const seam = yield* HarnessSeam;

  return {
    subscribe: (input: SubscribeThreadInput) =>
      Option.isSome(input.conversationId)
        ? Stream.fail(noSubagents(input.threadId))
        : seam
            .watch(input.threadId)
            .pipe(
              Stream.mapError((failure) =>
                toLookupError(failure, input.threadId)
              )
            ),
    history: (input: HistoryInput) =>
      Option.isSome(input.conversationId)
        ? Effect.fail(noSubagents(input.threadId))
        : seam
            .history(input.threadId, {
              before: input.before,
              limit: input.limit,
            })
            .pipe(
              Effect.mapError((failure) =>
                toLookupError(failure, input.threadId)
              )
            ),
    entry: (input: EntryInput) =>
      seam
        .entry(input.threadId, input.entryId)
        .pipe(
          Effect.mapError((failure) =>
            toLookupError(failure, `${input.threadId}/${input.entryId}`)
          )
        ),
    retryTask: (input: RetryTaskInput) =>
      seam
        .retry(input.taskId)
        .pipe(
          Effect.mapError((failure) =>
            toLookupError(failure, String(input.taskId))
          )
        ),
  };
});

/** The handlers of the thread stream's RPCs, to merge over the stubs in `rpc/Handlers.ts`. */
export const ThreadStreamHandlers = {
  layer: Layer.mergeAll(
    CairnRpcs.toLayerHandler(
      "thread.subscribe",
      Effect.map(threadStreamHandlers, (handlers) => handlers.subscribe)
    ),
    CairnRpcs.toLayerHandler(
      "thread.history",
      Effect.map(threadStreamHandlers, (handlers) => handlers.history)
    ),
    CairnRpcs.toLayerHandler(
      "thread.entry",
      Effect.map(threadStreamHandlers, (handlers) => handlers.entry)
    ),
    CairnRpcs.toLayerHandler(
      "thread.retryTask",
      Effect.map(threadStreamHandlers, (handlers) => handlers.retryTask)
    )
  ),
};
