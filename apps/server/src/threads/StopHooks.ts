// What else runs when a thread is stopped, after the harness stopped its run. A held Claude query
// outlives its generation signal, so the bridge's explicit abort hooks in here (it arrives with the
// bridge wiring); the default runs nothing. A hook's failure is logged, never the stop's failure:
// the run is already stopped.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Context, Effect, Layer } from "effect";

/** One stop hook: a name for the log and the effect to run for a stopped thread. */
export interface StopHook<E, R> {
  readonly name: string;
  run(threadId: ThreadId): Effect.Effect<void, E, R>;
}

/** Runs the stop hooks for a stopped thread. */
export class StopHooks extends Context.Service<
  StopHooks,
  {
    /** Runs every hook in order; failures are logged and skipped. */
    run(threadId: ThreadId): Effect.Effect<void>;
  }
>()("cairn/server/threads/StopHooks") {
  /** No hooks. */
  static readonly layerNone = Layer.succeed(
    StopHooks,
    StopHooks.of({ run: () => Effect.void })
  );

  /** Runs `hooks` in order; their requirements are the layer's. */
  static readonly layerFrom = <E, R>(hooks: ReadonlyArray<StopHook<E, R>>) =>
    Layer.effect(
      StopHooks,
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();

        const run = Effect.fn("StopHooks.run")(function* (threadId: ThreadId) {
          for (const hook of hooks) {
            yield* hook.run(threadId).pipe(
              Effect.provideContext(context),
              Effect.catchCause((cause) =>
                Effect.logWarning("stop hook failed").pipe(
                  Effect.annotateLogs({
                    event: "stop_hook_failed",
                    hook: hook.name,
                    threadId,
                    cause: String(cause),
                  })
                )
              )
            );
          }
        });

        return StopHooks.of({ run });
      })
    );
}
