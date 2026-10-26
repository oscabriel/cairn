// What a failed call says and whether to try it again, read the same way everywhere: the protocol's
// errors carry a `message` (the brain's sentence) and most a `retryable` verdict; the transport's
// carry neither, and nothing known ran.

import { Cause, Option, Predicate } from "effect";

/** A failed call: a protocol error or the transport's, told apart by `_tag`. */
export interface CallFailure {
  readonly _tag: string;
}

/** The brain's sentence for a failure, or `fallback` when it carries none. */
export const failureMessage = (
  failure: CallFailure,
  fallback: string
): string =>
  Predicate.hasProperty(failure, "message") &&
  Predicate.isString(failure.message)
    ? failure.message
    : fallback;

/** `failureMessage` with the failure's tag as the fallback. */
export const failureMessageOrTag = (failure: CallFailure): string =>
  failureMessage(failure, `The request failed (${failure._tag}).`);

/** True for a failure that carries no `retryable` verdict: the transport's, where nothing known ran. */
export const isTransport = (failure: CallFailure): boolean =>
  !(
    Predicate.hasProperty(failure, "retryable") &&
    Predicate.isBoolean(failure.retryable)
  );

/** A failure the brain marked retryable, or one of the transport. */
export const isRetryable = (failure: CallFailure): boolean =>
  Predicate.hasProperty(failure, "retryable") &&
  Predicate.isBoolean(failure.retryable)
    ? failure.retryable
    : true;

/** What a stream's end says: the failure's sentence, `failed` without one, `interrupted` without a failure. */
export const causeMessage = (
  cause: Cause.Cause<unknown>,
  interrupted: string,
  failed: string
): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => interrupted,
    onSome: (failure) =>
      Predicate.hasProperty(failure, "message") &&
      Predicate.isString(failure.message)
        ? failure.message
        : failed,
  });
