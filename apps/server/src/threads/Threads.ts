// The thread commands a client sends after launch: a turn (send), stop, withdraw a queued input,
// change the model or thinking level, and answer an approval. Each is a thin call into the harness
// seam, which keeps them idempotent (a turn by its request id) and durable. A turn sent while its
// thread launches follows the launch to its end. Stop keeps queued inputs unless asked to clear
// them (plan D16), then runs the stop hooks; a stop during the launch cancels the launch.

import type { ThreadId } from "@cairn/protocol/Ids";
import type {
  ConfigureInput,
  RespondInput,
  SendInput,
  SendResult,
  StopInput,
  WithdrawInput,
  WithdrawResult,
} from "@cairn/protocol/Thread";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

import type { HarnessError } from "../brain/HarnessSeam.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
  ThreadMessageSent,
} from "../shell/ShellCommands.ts";
import type { ShellStoreError } from "../shell/ShellStoreError.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { LaunchStore } from "./LaunchStore.ts";
import type { LaunchStoreError } from "./LaunchStore.ts";
import { StopHooks } from "./StopHooks.ts";
import { ThreadLaunch } from "./ThreadLaunch.ts";
import { logTurnSubmitted, TurnContent } from "./TurnContent.ts";
import type { TurnContentError } from "./TurnContent.ts";

/** The thread is still being launched; its first message has not reached the brain yet. */
export class ThreadNotReady extends Schema.TaggedError<ThreadNotReady>()(
  "ThreadNotReady",
  {
    message: Schema.String,
    threadId: Schema.String,
  }
) {}

/**
 * The thread's launch row outlived its launch: no launch of it runs and its thread was never
 * created, because a restart cut the launch off before the thread existed. Sending again cannot
 * help; the thread has to be launched again.
 */
export class ThreadLaunchLost extends Schema.TaggedError<ThreadLaunchLost>()(
  "ThreadLaunchLost",
  {
    message: Schema.String,
    threadId: Schema.String,
  }
) {}

/**
 * How long a turn sent to a thread whose launch is recorded but not running in this process (after
 * a restart, before boot resumes it) waits for the launch to start or end before it is refused with
 * `ThreadNotReady`; a launch that runs here is followed instead, up to `LaunchFollowLimit`. A
 * thread subscription also waits this long for a launch to ensure its thread.
 */
export const LaunchWait = Context.Reference<Duration.Duration>(
  "cairn/server/threads/Threads/LaunchWait",
  { defaultValue: () => Duration.seconds(60) }
);

/**
 * The longest a turn waits on its thread's launch before it is refused with `ThreadNotReady`. Above
 * the slowest launch the workspace step allows (a fetch and a `git worktree add`, 12 minutes
 * between them), so only a stuck launch reaches it.
 */
export const LaunchFollowLimit = Context.Reference<Duration.Duration>(
  "cairn/server/threads/Threads/LaunchFollowLimit",
  { defaultValue: () => Duration.minutes(15) }
);

/** How often a waiting turn checks on a launch that is recorded but not running here. */
const LAUNCH_POLL = Duration.millis(100);

const notReady = (threadId: ThreadId) =>
  new ThreadNotReady({
    message: `Thread ${threadId} is still being prepared. Send again once it shows its first message.`,
    threadId,
  });

/** Sends turns to threads and steers their runs. */
export class Threads extends Context.Service<
  Threads,
  {
    /**
     * Builds the turn's content and admits it. Idempotent by the input's request id: a resend
     * returns the first submission. A turn for a thread that is still launching follows the
     * launch to its end, so it lands after the first message. Fails with `TurnContentError`
     * (nothing submitted), `ThreadNotReady` when the launch outlasts `LaunchWait` without running
     * here or `LaunchFollowLimit` in all, `ThreadLaunchLost` at once when the launch can no longer
     * make the thread, or the seam's `HarnessError`.
     */
    send(
      input: SendInput,
      from: string
    ): Effect.Effect<
      SendResult,
      | HarnessError
      | TurnContentError
      | ThreadNotReady
      | ThreadLaunchLost
      | LaunchStoreError
      | ShellStoreError
    >;
    /**
     * Stops the run (keeping queued inputs unless `clearQueue`), then runs the stop hooks. A thread
     * still launching has no run yet: its launch is cancelled instead and its row marked failed.
     */
    stop(
      input: StopInput
    ): Effect.Effect<void, HarnessError | LaunchStoreError>;
    /** Takes back one queued input; `withdrawn: false` when it had already been placed. */
    withdraw(input: WithdrawInput): Effect.Effect<WithdrawResult, HarnessError>;
    /** Changes the model or thinking level of later turns, and the sidebar row with them. */
    configure(input: ConfigureInput): Effect.Effect<void, HarnessError>;
    /** Answers one approval. */
    respond(input: RespondInput): Effect.Effect<void, HarnessError>;
  }
>()("cairn/server/threads/Threads") {
  /**
   * Needs `HarnessSeam`, `TurnContent`, `StopHooks`, `ThreadLaunch`, `LaunchStore`, `ThreadRows`
   * and `EventSink`.
   */
  static readonly layerNoDeps = Layer.effect(
    Threads,
    Effect.gen(function* () {
      const seam = yield* HarnessSeam;
      const turns = yield* TurnContent;
      const stopHooks = yield* StopHooks;
      const launcher = yield* ThreadLaunch;
      const launches = yield* LaunchStore;
      const threadRows = yield* ThreadRows;
      const sink = yield* EventSink;

      // Returns once no launch of the thread is recorded. A launch running here is followed to its
      // end; one recorded but not running (a restart's, before boot resumes it) is polled.
      const untilLaunched = Effect.fnUntraced(function* (threadId: ThreadId) {
        const wait = Duration.toMillis(yield* LaunchWait);
        let polledSince = Option.none<number>();

        while (true) {
          if (Option.isNone(yield* launches.byThread(threadId))) {
            return yield* Effect.void;
          }

          if (yield* launcher.follow(threadId)) {
            polledSince = Option.none();
            continue;
          }

          if (Option.isNone(yield* threadRows.get(threadId))) {
            return yield* new ThreadLaunchLost({
              message: `Thread ${threadId} was never created: its launch stopped before the thread existed. Launch it again with the same message.`,
              threadId,
            });
          }

          const now = yield* Clock.currentTimeMillis;

          if (now - Option.getOrElse(polledSince, () => now) >= wait) {
            return yield* notReady(threadId);
          }

          polledSince = Option.orElse(polledSince, () => Option.some(now));
          yield* Effect.sleep(LAUNCH_POLL);
        }
      });

      // A message the user sends brings a thread settled by hand (or unsettled by hand) back under
      // auto-settle and ends its snooze, as t3code does. The turn is already admitted, so a failure
      // here is logged rather than failing the send.
      const recordMessageSent = (threadId: ThreadId) =>
        Effect.gen(function* () {
          const row = yield* threadRows.get(threadId);

          const touched = Option.exists(
            row,
            ({ shell }) =>
              Option.isSome(shell.settledOverride) ||
              Option.isSome(shell.snoozedUntil)
          );

          if (touched) {
            yield* sink.commitCommand(
              ThreadMessageSent.make({
                commandId: yield* sink.mintCommandId,
                threadId,
              })
            );
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sent message not recorded in the shell").pipe(
              Effect.annotateLogs({
                event: "thread_message_sent_record_failed",
                threadId,
                cause: String(cause),
              })
            )
          )
        );

      const send = Effect.fn("Threads.send")(function* (
        input: SendInput,
        from: string
      ) {
        const limit = yield* LaunchFollowLimit;

        yield* untilLaunched(input.threadId).pipe(
          Effect.timeoutOrElse({
            duration: limit,
            orElse: () => Effect.fail(notReady(input.threadId)),
          })
        );

        const built = yield* turns.build(input.threadId, from, input.input);

        const submission = yield* seam.submit(input.threadId, {
          requestId: input.input.requestId,
          content: built.content,
          entry: built.entry,
          whenBusy: input.whenBusy,
        });

        yield* logTurnSubmitted(input.threadId, input.input, built, submission);
        yield* recordMessageSent(input.threadId);

        return { submissionId: submission.submissionId };
      });

      const stop = Effect.fn("Threads.stop")(function* (input: StopInput) {
        if (yield* launcher.cancel(input.threadId)) {
          return;
        }

        yield* seam.stop(input.threadId, { clearQueue: input.clearQueue });
        yield* stopHooks.run(input.threadId);
      });

      const withdraw = Effect.fn("Threads.withdraw")(function* (
        input: WithdrawInput
      ) {
        return yield* seam.withdraw(input.threadId, input.submissionId);
      });

      // The sidebar row shows the thread's model; the shell projector would correct it later, but
      // the picker should not wait for that.
      const recordModel = Effect.fnUntraced(function* (
        threadId: ThreadId,
        input: ConfigureInput
      ) {
        if (Option.isNone(input.model) && Option.isNone(input.thinkingLevel)) {
          return;
        }

        yield* sink
          .commitCommand(
            ThreadActivityUpdate.make({
              commandId: yield* sink.mintCommandId,
              threadId,
              patch: {
                ...emptyActivityPatch,
                provider: Option.map(input.model, (model) => model.provider),
                modelId: Option.map(input.model, (model) => model.modelId),
                thinkingLevel: input.thinkingLevel,
              },
            })
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("thread model not recorded in the shell").pipe(
                Effect.annotateLogs({
                  event: "thread_model_record_failed",
                  threadId,
                  cause: String(cause),
                })
              )
            )
          );
      });

      const configure = Effect.fn("Threads.configure")(function* (
        input: ConfigureInput
      ) {
        yield* seam.configure(input.threadId, {
          model: input.model,
          thinkingLevel: input.thinkingLevel,
          cwd: Option.none(),
        });
        yield* recordModel(input.threadId, input);
      });

      const respond = Effect.fn("Threads.respond")(function* (
        input: RespondInput
      ) {
        yield* seam.respond(input.threadId, input.approvalId, input.decision);
      });

      return Threads.of({ send, stop, withdraw, configure, respond });
    })
  );
}
