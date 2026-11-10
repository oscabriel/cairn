// How brain code calls pi-durable, and how pi-durable calls back into Effect.
//
// - Every promise enters through `durable`, which hands pi-durable a chord Context cancelled when
//   the Effect is interrupted, opens a span named by the operation, and turns a rejection into a
//   typed error that remembers the operation. "Harness is closed" is recognised everywhere, because
//   every promise the brain holds on a closing Harness rejects with it and that is a normal end, not
//   a failure.
// - Every callback pi-durable makes into Cairn (a tool's `execute`, a task's phases, a hook, a watch
//   listener) runs its Effects through a `DurableRunner`: the context of the extension layer that
//   built it, so its lines reach the app's loggers at the app's level and its spans the app's
//   tracer (coding standard S43). A bare `Effect.runPromise` would run on Effect's defaults and its
//   lines would leave the events log; `automation/no-bare-effect-run` refuses one.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { WatchCall } from "@earendil-works/pi-durable";
import { Effect, Option, Predicate, Schema } from "effect";
import type { Context, Exit, Fiber } from "effect";

/** A pi-durable call rejected. `closed` is true when the Harness was closing or had closed. */
export class DurableCallError extends Schema.TaggedError<DurableCallError>()(
  "DurableCallError",
  {
    message: Schema.String,
    operation: Schema.String,
    closed: Schema.Boolean,
    cause: Schema.Defect(),
  }
) {}

/** The message text of anything a library threw, or a fixed placeholder. */
export const errorText = (cause: unknown): string =>
  Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)
    ? cause.message
    : String(cause);

/**
 * True when the error is pi-durable's "Harness is closed" (or its Session's equivalent). pi-durable
 * 1.5.1 still throws a plain `Error` for a close (`harness/util.js` `closedError`, `session.js`);
 * its typed errors (`SessionFailed`, `ConversationBusy`, `ConversationIdle`, `ReadOnlySession`)
 * name other conditions, so the text is the only mark.
 */
export const isClosedError = (cause: unknown): boolean => {
  const text = errorText(cause);

  return (
    text.includes("Harness is closed") ||
    text.includes("Session is closed") ||
    text.includes("closed Session")
  );
};

/** The chord Context pi-durable calls get: cancelled with the calling fiber. */
export const contextFor = (signal: AbortSignal): ChordContext =>
  withAbortSignal(signal, BACKGROUND_CONTEXT);

/**
 * Runs one pi-durable call in a span named `durable.<operation>`. Interrupting the Effect cancels
 * the call's wait, not its commit.
 */
export const durable = <A>(
  operation: string,
  run: (context: ChordContext) => Promise<A>
): Effect.Effect<A, DurableCallError> =>
  Effect.tryPromise({
    try: async (signal) => await run(contextFor(signal)),
    catch: (cause) =>
      new DurableCallError({
        message: `pi-durable ${operation} failed: ${errorText(cause)}`,
        operation,
        closed: isClosedError(cause),
        cause,
      }),
  }).pipe(Effect.withSpan(`durable.${operation}`));

/**
 * The structured fields of a lifecycle line: ids (thread, conversation, task, record) and the
 * decision's words, never message text or credentials.
 */
export type LineFields = Readonly<
  Record<string, string | number | boolean | null>
>;

/**
 * How code pi-durable calls (a tool's `execute`, a task's phases, a hook, a watch listener) runs an
 * Effect: on the context of the layer that built it (coding standard S43). Each method is its
 * `Effect.run*` namesake over that context, with the same interruption and failure semantics, so a
 * site passes its call's abort signal as it would to the bare one.
 */
export interface DurableRunner {
  readonly promise: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions
  ) => Promise<A>;
  readonly promiseExit: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions
  ) => Promise<Exit.Exit<A, E>>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E>,
    options?: Effect.RunOptions
  ) => Fiber.Fiber<A, E>;
  readonly syncExit: <A, E>(effect: Effect.Effect<A, E>) => Exit.Exit<A, E>;
  /**
   * Writes one lifecycle line at info: `message` says what was decided, `fields` (with `event`)
   * which thing and why. Never throws and never waits, so a task phase can call it anywhere.
   */
  readonly line: (message: string, fields: LineFields) => void;
}

/** The runner over `context`. Production takes the extension layer's (`durableRunner`). */
export const runnerOf = (context: Context.Context<never>): DurableRunner => {
  const fork = Effect.runForkWith(context);

  return {
    promise: Effect.runPromiseWith(context),
    promiseExit: Effect.runPromiseExitWith(context),
    fork,
    syncExit: Effect.runSyncExitWith(context),
    line: (message, fields) => {
      // A logger runs synchronously, so the line is written before this returns.
      fork(Effect.logInfo(message).pipe(Effect.annotateLogs(fields)));
    },
  };
};

/** The runner over the calling layer's context: what an extension layer gives its tools and tasks. */
export const durableRunner: Effect.Effect<DurableRunner> = Effect.map(
  Effect.context(),
  runnerOf
);

/**
 * A document watch's call as a value (pi-durable 1.5): the document's value, or null once it was
 * retired and nothing replaced it. None for a call that carries no value (a source failure, which a
 * Durable watch never sends).
 */
export const documentCall = <A>(
  call: WatchCall<A>
): Option.Option<A | null> => {
  if (call.kind !== "value") {
    return Option.none();
  }

  return Option.some(call.retired && call.ops.length === 0 ? null : call.value);
};

/**
 * A pi-durable listener (a watch, the commit feed) that only hands each value on. pi-durable awaits
 * a watch listener before its next frame, so one that never blocks keeps frames in order.
 */
export const handOff =
  <A>(onValue: (value: A) => void) =>
  async (value: A): Promise<void> => {
    onValue(value);
    await Promise.resolve();
  };
