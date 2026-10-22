// The thread commands a client sends after launch: a turn (send), stop, withdraw a queued input,
// change the model or thinking level, and answer an approval. Each is a thin call into the harness
// seam, which keeps them idempotent (a turn by its request id) and durable. Stop keeps queued
// inputs unless asked to clear them (plan D16), then runs the stop hooks.
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
import { Context, Effect, Layer, Option, Schema } from "effect";

import type { HarnessError } from "../brain/HarnessSeam.ts";
import { HarnessSeam } from "../brain/HarnessSeam.ts";
import { EventSink } from "../shell/EventSink.ts";
import {
  emptyActivityPatch,
  ThreadActivityUpdate,
} from "../shell/ShellCommands.ts";
import { LaunchStore } from "./LaunchStore.ts";
import type { LaunchStoreError } from "./LaunchStore.ts";
import { StopHooks } from "./StopHooks.ts";
import { TurnContent } from "./TurnContent.ts";
import type { TurnContentError } from "./TurnContent.ts";

/** The thread is still being launched; its first message has not reached the brain yet. */
export class ThreadNotReady extends Schema.TaggedError<ThreadNotReady>()(
  "ThreadNotReady",
  {
    message: Schema.String,
    threadId: Schema.String,
  }
) {}

/** Sends turns to threads and steers their runs. */
export class Threads extends Context.Service<
  Threads,
  {
    /**
     * Builds the turn's content and admits it. Idempotent by the input's request id: a resend
     * returns the first submission. Fails with `TurnContentError` (nothing submitted),
     * `ThreadNotReady` while the thread launches, or the seam's `HarnessError`.
     */
    send(
      input: SendInput,
      from: string
    ): Effect.Effect<
      SendResult,
      HarnessError | TurnContentError | ThreadNotReady | LaunchStoreError
    >;
    /** Stops the run (keeping queued inputs unless `clearQueue`), then runs the stop hooks. */
    stop(input: StopInput): Effect.Effect<void, HarnessError>;
    /** Takes back one queued input; `withdrawn: false` when it had already been placed. */
    withdraw(input: WithdrawInput): Effect.Effect<WithdrawResult, HarnessError>;
    /** Changes the model or thinking level of later turns, and the sidebar row with them. */
    configure(input: ConfigureInput): Effect.Effect<void, HarnessError>;
    /** Answers one approval. */
    respond(input: RespondInput): Effect.Effect<void, HarnessError>;
  }
>()("cairn/server/threads/Threads") {
  /** Needs `HarnessSeam`, `TurnContent`, `StopHooks`, `LaunchStore` and `EventSink`. */
  static readonly layerNoDeps = Layer.effect(
    Threads,
    Effect.gen(function* () {
      const seam = yield* HarnessSeam;
      const turns = yield* TurnContent;
      const stopHooks = yield* StopHooks;
      const launches = yield* LaunchStore;
      const sink = yield* EventSink;

      const send = Effect.fn("Threads.send")(function* (
        input: SendInput,
        from: string
      ) {
        const launching = yield* launches.byThread(input.threadId);

        if (Option.isSome(launching)) {
          return yield* new ThreadNotReady({
            message: `Thread ${input.threadId} is still being prepared. Send again once it shows its first message.`,
            threadId: input.threadId,
          });
        }

        const built = yield* turns.build(input.threadId, from, input.input);

        const submission = yield* seam.submit(input.threadId, {
          requestId: input.input.requestId,
          content: built.content,
          entry: built.entry,
          whenBusy: input.whenBusy,
        });

        return { submissionId: submission.submissionId };
      });

      const stop = Effect.fn("Threads.stop")(function* (input: StopInput) {
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
