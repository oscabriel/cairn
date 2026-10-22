// The brain's SIGTERM order (ADR 0022). `NodeRuntime.runMain` interrupts the root on SIGTERM and
// the root layer's finalizers run in reverse build order, so: `begin` (log `closing`, refuse new
// sockets), then the HTTP server closes its listener and every socket with 1001 (2 s grace), then
// the close hooks in their listed order (`ShutdownHooks.ts`: the bridge's `beginClosing`, the
// Harness with its 5 s timeout, ...), then SQLite as its layer ends, then exit 130. A watchdog logs
// `shutdown_slow` at 20 s so the journal names the step that ignored its signal before systemd's
// `TimeoutStopSec` sends SIGKILL.
import {
  Clock,
  Context,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
} from "effect";

/** One step of shutdown: a name for the log, the effect, and how long it may take. */
export interface ShutdownHook<R> {
  readonly name: string;
  readonly close: Effect.Effect<void, never, R>;
  readonly timeout: Duration.Duration;
}

/**
 * Builds a close hook. A failure or a timeout is logged and shutdown moves on to the next hook;
 * nothing a hook does can keep the process alive past its timeout.
 */
export const shutdownHook = <E, R>(
  name: string,
  close: Effect.Effect<void, E, R>,
  timeout: Duration.Input = "5 seconds"
): ShutdownHook<R> => ({
  name,
  close: close.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("shutdown hook failed").pipe(
        Effect.annotateLogs({
          event: "shutdown_hook_failed",
          hook: name,
          cause: String(cause),
        })
      )
    )
  ),
  timeout: Duration.fromInputUnsafe(timeout),
});

/** When the watchdog reports a slow shutdown; below systemd's `TimeoutStopSec=30`. */
export const SHUTDOWN_SLOW_AFTER = "20 seconds";

/** Whether the brain is closing, and the step that starts it. */
export class Shutdown extends Context.Service<
  Shutdown,
  {
    /**
     * Starts shutdown: logs `closing` and makes `isClosing` true. Called by the listener's own
     * finalizer, before the HTTP server closes. Idempotent.
     */
    readonly begin: Effect.Effect<void>;
    /** True once shutdown began; `/ws` then refuses new sockets with 503. */
    readonly isClosing: Effect.Effect<boolean>;
  }
>()("cairn/server/Shutdown") {
  /**
   * The shutdown service running `hooks` in order when the root scope closes, then logging
   * `closed` with the milliseconds since `begin`.
   */
  static readonly layerFrom = <R>(hooks: ReadonlyArray<ShutdownHook<R>>) =>
    Layer.effect(
      Shutdown,
      Effect.gen(function* () {
        const startedAt = yield* Ref.make(Option.none<number>());

        const begin = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;

          const first = yield* Ref.modify(startedAt, (current) =>
            Option.isNone(current) ? [true, Option.some(now)] : [false, current]
          );

          if (first) {
            yield* Effect.logInfo("closing").pipe(
              Effect.annotateLogs({ event: "closing" })
            );
          }
        }).pipe(Effect.withSpan("Shutdown.begin"));

        const runHooks = Effect.gen(function* () {
          yield* begin;

          const watchdog = yield* Effect.logWarning("shutdown_slow").pipe(
            Effect.annotateLogs({ event: "shutdown_slow" }),
            Effect.delay(SHUTDOWN_SLOW_AFTER),
            Effect.forkDetach
          );

          for (const hook of hooks) {
            yield* hook.close.pipe(
              Effect.timeoutOrElse({
                duration: hook.timeout,
                orElse: () =>
                  Effect.logWarning("shutdown hook timed out").pipe(
                    Effect.annotateLogs({
                      event: "shutdown_hook_timeout",
                      hook: hook.name,
                    })
                  ),
              })
            );
          }

          yield* Fiber.interrupt(watchdog);
          const now = yield* Clock.currentTimeMillis;
          const began = Option.getOrElse(yield* Ref.get(startedAt), () => now);
          const ms = now - began;

          yield* Effect.logInfo(`closed ${ms}`).pipe(
            Effect.annotateLogs({ event: "closed", ms })
          );
        });

        yield* Effect.addFinalizer(() => runHooks);

        return Shutdown.of({
          begin,
          isClosing: Effect.map(Ref.get(startedAt), Option.isSome),
        });
      })
    );
}
