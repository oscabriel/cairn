// How brain code calls pi-durable: every promise enters through `durable`, which hands pi-durable a
// chord Context cancelled when the Effect is interrupted, and turns a rejection into a typed error
// that remembers the operation. "Harness is closed" is recognised everywhere, because every promise
// the brain holds on a closing Harness rejects with it and that is a normal end, not a failure.

import type { Context as ChordContext } from "@earendil-works/chord/context";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { Effect, Predicate, Schema } from "effect";

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

/** True when the error is pi-durable's "Harness is closed" (or its Session's equivalent). */
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

/** Runs one pi-durable call. Interrupting the Effect cancels the call's wait, not its commit. */
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
  });

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
