// The thread stream's RPCs: `thread.subscribe`, `thread.history`, `thread.entry` and
// `thread.retryTask`. Each is a thin call into the harness seam; this module only translates the
// seam's failures into the protocol's errors. Subagent conversations inside a thread arrive with
// subagents; until then a `conversationId` is refused as not found.
//
// A subscribe to a thread whose launch is still in flight waits for the launch's ensure (or for the
// launch to end, or `LaunchWait`) before it watches, because the client opens the thread page as
// soon as it queues the launch. A thread with no launch row answers at once: it exists, it failed,
// or its launch has not reached the brain yet, which only the client can tell apart.

import { Internal, NotFound, Unavailable } from "@cairn/protocol/Errors";
import type { ThreadId } from "@cairn/protocol/Ids";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import type {
  EntryInput,
  HistoryInput,
  RetryTaskInput,
  SubscribeThreadInput,
} from "@cairn/protocol/Thread";
import { Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import type { HarnessError } from "../brain/HarnessSeam.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { ShellProjector } from "../shell/ShellProjector.ts";
import { LaunchStore } from "../threads/LaunchStore.ts";
import type { LaunchStoreError } from "../threads/LaunchStore.ts";
import { LaunchWait } from "../threads/Threads.ts";

/** How often a subscribe waiting on a launch checks whether the launch ended. */
const LAUNCH_POLL = Duration.millis(100);

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

const launchesUnavailable = (failure: LaunchStoreError) =>
  new Unavailable({
    message: `The thread stream could not read the thread's launch: ${failure.message}`,
  });

/** The four handlers, for the handler group and for tests that call them directly. */
export const threadStreamHandlers = Effect.gen(function* () {
  const seam = yield* HarnessSeam;
  const launches = yield* LaunchStore;
  const projector = yield* ShellProjector;

  // Returns once the thread's launch has ensured it, ended, or outlasted `LaunchWait`; at once
  // when no launch is in flight. The watch after it answers for itself either way.
  const untilLaunched = Effect.fn("ThreadStreamHandlers.untilLaunched")(
    function* (threadId: ThreadId) {
      const pending = yield* launches
        .byThread(threadId)
        .pipe(Effect.mapError(launchesUnavailable));

      if (Option.isNone(pending)) {
        return;
      }

      const wait = yield* LaunchWait;

      const ended = launches.byThread(threadId).pipe(
        Effect.repeat({
          until: Option.isNone,
          schedule: Schedule.spaced(LAUNCH_POLL),
        }),
        Effect.mapError(launchesUnavailable)
      );

      const ensured = seam
        .whenEnsured(threadId)
        .pipe(Effect.mapError((failure) => toLookupError(failure, threadId)));

      yield* Effect.raceFirst(ensured, Effect.asVoid(ended)).pipe(
        Effect.timeoutOption(wait)
      );
    }
  );

  return {
    subscribe: (input: SubscribeThreadInput) =>
      Option.isSome(input.conversationId)
        ? Stream.fail(noSubagents(input.threadId))
        : Stream.unwrap(
            untilLaunched(input.threadId).pipe(
              Effect.as(
                seam
                  .watch(input.threadId)
                  .pipe(
                    Stream.mapError((failure) =>
                      toLookupError(failure, input.threadId)
                    )
                  )
              )
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
    // The row drops the task from `parkedTaskIds` at once, rather than at the next reconcile (T39).
    retryTask: (input: RetryTaskInput) =>
      seam.retry(input.taskId).pipe(
        Effect.mapError((failure) =>
          toLookupError(failure, String(input.taskId))
        ),
        Effect.tap(() => projector.refresh(input.threadId))
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
