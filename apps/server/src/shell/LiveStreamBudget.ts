// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/LiveStreamBudget.ts and
// apps/server/src/rpcInitialItems.ts at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the budget
// that charges every item from the moment it is queued until the client acknowledges the batch it
// rode in, the latest-state coalescing buffer, and the subscribe-before-high-water replay. Changed:
// limits are a required struct with exported defaults, the failure is an Option, and sizes are
// measured with the item's JSON form (Options and DateTimes included), which overstates the wire
// size slightly and so errs on the safe side.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import {
  Array as Arr,
  Deferred,
  Effect,
  Exit,
  Option,
  PubSub,
  Queue,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import type { Cause } from "effect";

/** A slow subscriber's buffer filled up; it should resubscribe from the last sequence it holds. */
export class LiveStreamBufferError extends Schema.TaggedError<LiveStreamBufferError>()(
  "LiveStreamBufferError",
  { message: Schema.String }
) {}

/** How much one subscription may hold for a client that has not acknowledged it yet. */
export interface LiveStreamLimits {
  readonly maxItems: number;
  readonly maxSerializedBytes: number;
}

/** The shell stream's limits: 1,000 items or 8 MiB of serialized items per subscription. */
export const DEFAULT_LIVE_STREAM_LIMITS: LiveStreamLimits = {
  maxItems: 1000,
  maxSerializedBytes: 8 * 1024 * 1024,
};

/** One item charged to a budget, with the size it was charged at. */
export interface RetainedLiveItem<A> {
  readonly value: A;
  readonly serializedBytes: number;
}

// Published items are immutable and shared across subscriptions. Measure each object once without
// keeping the item or its serialized copy alive.
const serializedSizes = new WeakMap<WeakKey, number>();

const serializedSize = (value: WeakKey): number => {
  const cached = serializedSizes.get(value);

  if (cached !== undefined) {
    return cached;
  }

  const bytes = Buffer.byteLength(JSON.stringify(value));
  serializedSizes.set(value, bytes);

  return bytes;
};

const overflowMessage =
  "The live event buffer is full. Resume from the last received sequence.";

/**
 * Makes a budget scoped to one subscription. Items are charged by `retain` or `replace`, delivered
 * through `deliver`, and released when the next pull shows the client acknowledged them.
 */
export const makeLiveStreamBudget = Effect.fnUntraced(function* (
  limits: LiveStreamLimits
) {
  const { maxItems, maxSerializedBytes } = limits;
  const failed = yield* Deferred.make<never, LiveStreamBufferError>();
  const cleanupComplete = yield* Deferred.make<true>();
  let failure = Option.none<LiveStreamBufferError>();
  const retained = new Set<RetainedLiveItem<unknown>>();
  let retainedSerializedBytes = 0;

  const release = (items: Iterable<RetainedLiveItem<unknown>>) => {
    for (const item of items) {
      if (retained.delete(item)) {
        retainedSerializedBytes -= item.serializedBytes;
      }
    }
  };

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      release(retained);
    }).pipe(Effect.andThen(Deferred.succeed(cleanupComplete, true)))
  );

  const check = Effect.suspend(() =>
    Option.match(failure, {
      onNone: () => Effect.void,
      onSome: (error) => Effect.fail(error),
    })
  );

  const overflow = Effect.fnUntraced(function* (
    nextItems: number,
    nextSerializedBytes: number
  ) {
    const error = Option.getOrElse(
      failure,
      () => new LiveStreamBufferError({ message: overflowMessage })
    );

    failure = Option.some(error);
    yield* Deferred.fail(failed, error);
    yield* Effect.logWarning("shell live buffer is full", {
      retainedItems: retained.size,
      retainedSerializedBytes,
      nextItems,
      nextSerializedBytes,
      maxItems,
      maxSerializedBytes,
    });

    return yield* error;
  });

  const retain = <A extends object>(value: A) =>
    Effect.suspend(() => {
      if (Option.isSome(failure)) {
        return Effect.fail(failure.value);
      }

      const serializedBytes = serializedSize(value);
      const nextItems = retained.size + 1;
      const nextSerializedBytes = retainedSerializedBytes + serializedBytes;

      if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes) {
        return overflow(nextItems, nextSerializedBytes);
      }

      const item: RetainedLiveItem<A> = { value, serializedBytes };
      retained.add(item);
      retainedSerializedBytes = nextSerializedBytes;

      return Effect.succeed(item);
    });

  const replace = <A extends object>(
    previous: Option.Option<RetainedLiveItem<unknown>>,
    value: A
  ) =>
    Effect.suspend(() => {
      if (Option.isSome(failure)) {
        return Effect.fail(failure.value);
      }

      const next: RetainedLiveItem<A> = {
        value,
        serializedBytes: serializedSize(value),
      };

      let nextItems = retained.size + 1;
      let nextSerializedBytes = retainedSerializedBytes + next.serializedBytes;

      if (Option.isSome(previous) && retained.has(previous.value)) {
        nextItems -= 1;
        nextSerializedBytes -= previous.value.serializedBytes;
      }

      if (nextItems > maxItems || nextSerializedBytes > maxSerializedBytes) {
        return overflow(nextItems, nextSerializedBytes);
      }

      release(Option.toArray(previous));
      retained.add(next);
      retainedSerializedBytes = nextSerializedBytes;

      return Effect.succeed(next);
    });

  const deliver = <A, E, R>(stream: Stream.Stream<RetainedLiveItem<A>, E, R>) =>
    Stream.fromPull(
      Effect.gen(function* () {
        yield* check;
        const sourceScope = yield* Scope.fork(yield* Effect.scope);

        const source = {
          pull: yield* Stream.toPull(stream).pipe(Scope.provide(sourceScope)),
        };

        let inFlight: ReadonlyArray<RetainedLiveItem<A>> = [];

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release(inFlight);
            inFlight = [];
            source.pull = Effect.interrupt;
          })
        );

        yield* Deferred.await(failed).pipe(
          Effect.catchTags({
            LiveStreamBufferError: (error) =>
              Effect.sync(() => {
                // A grouped source can retain its own pending chunk. Close it and release the
                // pull closure without waiting for an RPC acknowledgement.
                source.pull = Effect.interrupt;
              }).pipe(
                Effect.andThen(Scope.close(sourceScope, Exit.fail(error))),
                Effect.andThen(
                  Effect.sync(() => {
                    const delivered = new Set<RetainedLiveItem<unknown>>(
                      inFlight
                    );

                    for (const item of retained) {
                      if (!delivered.has(item)) {
                        release([item]);
                      }
                    }
                  })
                ),
                Effect.andThen(Deferred.succeed(cleanupComplete, true))
              ),
          }),
          Effect.forkScoped
        );

        // The RPC server asks for the next batch only after the client acknowledged this one, so
        // a pull is where the previous batch stops counting against the budget.
        // @effect-diagnostics-next-line returnEffectInGen:off - Stream.fromPull needs the pull effect as its result.
        return Effect.gen(function* () {
          release(inFlight);
          inFlight = [];
          yield* check;

          const items = yield* Effect.raceFirst(
            source.pull,
            Deferred.await(failed)
          );

          inFlight = items;
          yield* check;

          return Arr.map(items, (item) => item.value);
        });
      })
    ).pipe(Stream.scoped);

  return {
    retain,
    replace,
    release,
    deliver,
    check,
    failed: Deferred.await(failed),
    closed: Deferred.await(cleanupComplete),
    usage: Effect.sync(() => ({
      retainedItems: retained.size,
      retainedSerializedBytes,
    })),
  };
});

type LiveStreamBudget = Effect.Success<ReturnType<typeof makeLiveStreamBudget>>;

const retainLiveStream = Effect.fnUntraced(function* <A extends object, E, R>(
  source: Stream.Stream<A, E, R>,
  budget: LiveStreamBudget
) {
  const queue = yield* Queue.unbounded<
    RetainedLiveItem<A>,
    E | LiveStreamBufferError | Cause.Done
  >();

  let closed = false;

  const close = Effect.fnUntraced(function* (
    reason: Option.Option<LiveStreamBufferError>
  ) {
    if (closed) {
      return;
    }

    closed = true;
    budget.release(
      yield* Queue.clear(queue).pipe(Effect.orElseSucceed(() => []))
    );

    if (Option.isSome(reason)) {
      yield* Queue.fail(queue, reason.value);
    }

    yield* Queue.shutdown(queue);
  });

  yield* Effect.addFinalizer(() => close(Option.none()));
  yield* budget.failed.pipe(
    Effect.catchTags({
      LiveStreamBufferError: (error) => close(Option.some(error)),
    }),
    Effect.forkScoped
  );
  yield* source.pipe(
    Stream.runForEach((value) =>
      budget.retain(value).pipe(
        Effect.flatMap((item) => Queue.offer(queue, item)),
        Effect.uninterruptible
      )
    ),
    Effect.raceFirst(budget.failed),
    Effect.exit,
    Effect.flatMap((exit) =>
      Exit.isFailure(exit)
        ? Queue.failCause(queue, exit.cause)
        : Queue.end(queue)
    ),
    Effect.forkScoped({ startImmediately: true })
  );

  return Stream.fromQueue(queue);
});

/** Buffers a live source for a slow reader, failing with `LiveStreamBufferError` past the limits. */
export const bufferLiveStream = <A extends object, E, R>(
  source: Stream.Stream<A, E, R>,
  limits: LiveStreamLimits = DEFAULT_LIVE_STREAM_LIMITS
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget(limits);

      return budget.deliver(yield* retainLiveStream(source, budget));
    })
  );

/**
 * Buffers a stream of whole states, keeping only the newest queued state per `key`. Delivered states
 * stay charged until the next pull shows the client acknowledged them.
 */
export const bufferLatestLiveStream = <
  A extends { readonly sequence: number },
  E,
  R,
>(
  source: Stream.Stream<A, E, R>,
  key: (value: A) => string,
  limits: LiveStreamLimits = DEFAULT_LIVE_STREAM_LIMITS
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget(limits);

      const ready = yield* Queue.bounded<
        true,
        E | LiveStreamBufferError | Cause.Done
      >(1);

      const mutex = yield* Semaphore.make(1);
      const pending = new Map<string, RetainedLiveItem<A>>();
      let closed = false;

      const close = (error: Option.Option<LiveStreamBufferError>) =>
        mutex.withPermit(
          Effect.gen(function* () {
            if (closed) {
              return;
            }

            closed = true;
            budget.release(pending.values());
            pending.clear();

            if (Option.isSome(error)) {
              yield* Queue.fail(ready, error.value);
            }

            yield* Queue.shutdown(ready);
          })
        );

      yield* Effect.addFinalizer(() => close(Option.none()));
      yield* budget.failed.pipe(
        Effect.catchTags({
          LiveStreamBufferError: (error) => close(Option.some(error)),
        }),
        Effect.forkScoped
      );
      yield* source.pipe(
        Stream.runForEach((value) =>
          mutex.withPermit(
            Effect.gen(function* () {
              yield* budget.check;

              if (closed) {
                return;
              }

              const identity = key(value);
              const previous = Option.fromNullishOr(pending.get(identity));

              if (
                Option.isSome(previous) &&
                previous.value.value.sequence >= value.sequence
              ) {
                return;
              }

              const wasEmpty = pending.size === 0;
              const item = yield* budget.replace(previous, value);
              pending.set(identity, item);

              // Only the empty-to-nonempty transition needs a wakeup; replacements must not leave
              // another token after this batch has drained.
              if (wasEmpty) {
                yield* Queue.offer(ready, true);
              }
            }).pipe(Effect.uninterruptible)
          )
        ),
        Effect.raceFirst(budget.failed),
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isFailure(exit)
            ? Queue.failCause(ready, exit.cause)
            : Queue.end(ready)
        ),
        Effect.forkScoped({ startImmediately: true })
      );

      const drainPending = mutex.withPermit(
        Effect.sync(() => {
          const items = [...pending.values()].toSorted(
            (left, right) => left.value.sequence - right.value.sequence
          );

          pending.clear();

          return items;
        })
      );

      // A wakeup always follows an insertion, so a batch is never empty; the loop only guards the
      // type.
      const takeBatch = Effect.gen(function* () {
        while (true) {
          yield* Queue.take(ready);
          const items = yield* drainPending;

          if (Arr.isArrayNonEmpty(items)) {
            return items;
          }
        }
      });

      // Moving a batch to delivery keeps its budget charge until the client acknowledges it.
      return budget.deliver(Stream.fromPull(Effect.succeed(takeBatch)));
    })
  );

/** What `replayAndBufferProjectedLiveEvents` needs: a live subscription and a durable replay. */
export interface ReplayLiveInput<
  A extends { readonly sequence: number },
  B,
  E,
  R,
> {
  /** Subscribes to the live tail; called before the high-water mark is read. */
  readonly subscribe: Effect.Effect<PubSub.Subscription<A>, never, Scope.Scope>;
  /** The newest committed sequence. */
  readonly latestSequence: Effect.Effect<number, E, R>;
  /** The committed items after `afterSequence` up to `throughSequence`, in order. */
  readonly replay: (throughSequence: number) => Stream.Stream<A, E, R>;
  /** The sequence the reader already holds. */
  readonly afterSequence: number;
  /** Drops live items the reader does not want before they are charged. */
  readonly filter: (event: A) => boolean;
  /** Maps an item to what the reader receives (a thin form, so a body is never retained). */
  readonly project: (event: A) => B;
}

/**
 * Subscribes and starts draining before reading the high-water mark, replays the durable range up
 * to it, then continues with the live tail past it. A blocked catch-up read or an unacknowledged
 * replay batch cannot strand an unbounded subscription: the budget fails the stream instead.
 */
export const replayAndBufferProjectedLiveEvents = <
  A extends { readonly sequence: number },
  B extends { readonly sequence: number },
  E,
  R,
>(
  input: ReplayLiveInput<A, B, E, R>,
  limits: LiveStreamLimits = DEFAULT_LIVE_STREAM_LIMITS
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget(limits);
      const subscriptionScope = yield* Scope.fork(yield* Effect.scope);

      const subscription = yield* input.subscribe.pipe(
        Scope.provide(subscriptionScope)
      );

      let throughSequence = input.afterSequence;

      const live = yield* retainLiveStream(
        // Taking one event at a time avoids retaining an uncharged batch while the drain charges
        // events to the budget.
        Stream.fromEffectRepeat(PubSub.take(subscription)).pipe(
          Stream.filter(
            (event) => event.sequence > throughSequence && input.filter(event)
          ),
          Stream.map(input.project),
          Stream.ensuring(Scope.close(subscriptionScope, Exit.void))
        ),
        budget
      );

      const replay = Stream.unwrap(
        input.latestSequence.pipe(
          Effect.map((highWater) => {
            throughSequence = Math.max(highWater, input.afterSequence);

            return input.replay(highWater).pipe(
              // The finite database page is independent of the live tail. Charge only the item
              // being delivered, so a fast reader can take a page larger than the budget.
              Stream.rechunk(1),
              Stream.mapEffect((event) => budget.retain(input.project(event)))
            );
          })
        )
      );

      return budget.deliver(
        Stream.concat(
          replay,
          live.pipe(
            Stream.filter((item) => {
              if (item.value.sequence > throughSequence) {
                return true;
              }

              budget.release([item]);

              return false;
            })
          )
        )
      );
    })
  );

/**
 * Emits `items` once and then forgets them, so a stream concatenated after them does not keep a
 * delivered snapshot alive for the life of the subscription.
 */
export const initialItems = <A>(items: ReadonlyArray<A>): Stream.Stream<A> => {
  let pending = Option.some(items);

  return Stream.unwrap(
    Effect.sync(() => {
      const initial = pending;
      pending = Option.none();

      return Option.match(initial, {
        onNone: () => Stream.empty,
        onSome: (values) => Stream.fromIterable(values),
      });
    })
  );
};
