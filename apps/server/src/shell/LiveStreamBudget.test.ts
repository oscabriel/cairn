// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/LiveStreamBudget.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Every case is kept; the replay helper fills in the
// filter and projection Cairn's API requires, and limits are whole structs.
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

import { assert, describe, it } from "@effect/vitest";
import type { Scope } from "effect";
import { Deferred, Effect, Fiber, PubSub, Queue, Result, Stream } from "effect";

import {
  bufferLatestLiveStream,
  bufferLiveStream,
  DEFAULT_LIVE_STREAM_LIMITS,
  makeLiveStreamBudget,
  replayAndBufferProjectedLiveEvents,
} from "./LiveStreamBudget.ts";
import type { LiveStreamLimits, RetainedLiveItem } from "./LiveStreamBudget.ts";

interface Event {
  readonly sequence: number;
  readonly text: string;
  readonly threadId: string;
}

const limits = (partial: Partial<LiveStreamLimits>): LiveStreamLimits => ({
  ...DEFAULT_LIVE_STREAM_LIMITS,
  ...partial,
});

const replayAndBuffer = (
  input: {
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<Event>,
      never,
      Scope.Scope
    >;
    readonly latestSequence: Effect.Effect<number>;
    readonly replay: (throughSequence: number) => Stream.Stream<Event>;
    readonly filter?: (event: Event) => boolean;
  },
  bufferLimits: LiveStreamLimits
) =>
  replayAndBufferProjectedLiveEvents(
    {
      subscribe: input.subscribe,
      latestSequence: input.latestSequence,
      replay: input.replay,
      afterSequence: 0,
      filter: input.filter ?? (() => true),
      project: (event: Event) => event,
    },
    bufferLimits
  );

const assertBufferFull = <A, E extends { readonly _tag: string }>(
  result: Result.Result<A, E>
) => {
  assert.isTrue(Result.isFailure(result));

  if (Result.isFailure(result)) {
    assert.strictEqual(result.failure._tag, "LiveStreamBufferError");
  }
};

const event = (sequence: number, text: string, threadId = "selected") => ({
  sequence,
  text,
  threadId,
});

describe(makeLiveStreamBudget, () => {
  it.effect(
    "closes the source without releasing a batch still waiting for an ACK",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const budget = yield* makeLiveStreamBudget(limits({ maxItems: 3 }));

          const queue =
            yield* Queue.unbounded<RetainedLiveItem<{ text: string }>>();

          const sourceClosed = yield* Deferred.make<true>();
          const first = yield* budget.retain({ text: "first" });
          const second = yield* budget.retain({ text: "second" });
          const third = yield* budget.retain({ text: "third" });

          yield* Queue.offerAll(queue, [first, second, third]);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const pull = yield* Stream.toPull(
                budget.deliver(
                  Stream.fromQueue(queue).pipe(
                    Stream.rechunk(1),
                    Stream.ensuring(Deferred.succeed(sourceClosed, true))
                  )
                )
              );

              assert.deepStrictEqual(yield* pull, [{ text: "first" }]);
              assert.strictEqual(yield* Queue.size(queue), 0);
              assert.strictEqual((yield* budget.usage).retainedItems, 3);

              const overflow = yield* budget
                .retain({ text: "fourth" })
                .pipe(Effect.result);

              assert.isTrue(Result.isFailure(overflow));
              yield* Deferred.await(sourceClosed);
              yield* budget.closed;
              assert.strictEqual((yield* budget.usage).retainedItems, 1);
            })
          );
          assert.deepStrictEqual(yield* budget.usage, {
            retainedItems: 0,
            retainedSerializedBytes: 0,
          });
        })
      )
  );
});

describe(bufferLiveStream, () => {
  it.effect(
    "stops draining a slow subscriber when its unacknowledged tail fills",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<{ text: string }>();
          const sourceClosed = yield* Deferred.make<true>();

          const pull = yield* Stream.toPull(
            bufferLiveStream(
              Stream.fromQueue(input).pipe(
                Stream.ensuring(Deferred.succeed(sourceClosed, true))
              ),
              limits({ maxItems: 2 })
            )
          );

          yield* Queue.offer(input, { text: "first" });
          assert.deepStrictEqual(yield* pull, [{ text: "first" }]);
          yield* Queue.offerAll(input, [{ text: "second" }, { text: "third" }]);
          yield* Deferred.await(sourceClosed);
          assertBufferFull(yield* pull.pipe(Effect.result));
        })
      )
  );
});

describe(bufferLatestLiveStream, () => {
  it.effect.each(["items", "bytes"] as const)(
    "counts an unacknowledged state against the %s limit when its replacement arrives",
    (limit) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseUpdate = yield* Deferred.make<true>();
          const closed = yield* Deferred.make<true>();
          const first = { sequence: 1, text: "é".repeat(20) };
          const next = { ...first, sequence: 2 };

          const pull = yield* Stream.toPull(
            bufferLatestLiveStream(
              Stream.concat(
                Stream.succeed(first),
                Stream.fromEffect(Deferred.await(releaseUpdate)).pipe(
                  Stream.map(() => next)
                )
              ).pipe(Stream.ensuring(Deferred.succeed(closed, true))),
              () => "same-thread",
              limit === "items"
                ? limits({ maxItems: 1 })
                : limits({
                    maxSerializedBytes: Buffer.byteLength(
                      JSON.stringify(first)
                    ),
                  })
            )
          );

          assert.deepStrictEqual(yield* pull, [first]);
          yield* Deferred.succeed(releaseUpdate, true);
          yield* Deferred.await(closed);
          assertBufferFull(yield* pull.pipe(Effect.result));
        })
      )
  );

  it.effect(
    "keeps only the newest queued state per key, in sequence order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const input = yield* Queue.unbounded<Event>();

          const pull = yield* Stream.toPull(
            bufferLatestLiveStream(
              Stream.fromQueue(input),
              (item) => item.threadId,
              DEFAULT_LIVE_STREAM_LIMITS
            )
          );

          yield* Queue.offer(input, event(1, "a1", "a"));
          assert.deepStrictEqual(yield* pull, [event(1, "a1", "a")]);
          yield* Queue.offerAll(input, [
            event(2, "b2", "b"),
            event(3, "a3", "a"),
            event(4, "b4", "b"),
          ]);
          yield* Effect.yieldNow;
          assert.deepStrictEqual(yield* pull, [
            event(3, "a3", "a"),
            event(4, "b4", "b"),
          ]);
        })
      )
  );
});

describe(replayAndBufferProjectedLiveEvents, () => {
  it.effect.each(["high-water", "replay"] as const)(
    "unsubscribes and cancels a blocked %s read on live overflow",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();

          const subscribed = yield* Deferred.make<PubSub.Subscription<Event>>();

          const readStarted = yield* Deferred.make<true>();
          const readClosed = yield* Deferred.make<true>();

          const blockedRead = Deferred.succeed(readStarted, true).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(readClosed, true))
          );

          const pull = yield* Stream.toPull(
            replayAndBuffer(
              {
                subscribe: PubSub.subscribe(pubsub).pipe(
                  Effect.tap((subscription) =>
                    Deferred.succeed(subscribed, subscription)
                  ),
                  Effect.orDie
                ),
                latestSequence:
                  phase === "high-water"
                    ? blockedRead.pipe(Effect.as(0))
                    : Effect.succeed(0),
                replay: () =>
                  phase === "replay"
                    ? Stream.fromEffect(blockedRead)
                    : Stream.empty,
              },
              limits({ maxItems: 2 })
            )
          );

          const reader = yield* pull.pipe(Effect.result, Effect.forkScoped);

          yield* Deferred.await(readStarted);
          yield* PubSub.publishAll(pubsub, [
            event(1, "one"),
            event(2, "two"),
            event(3, "overflow"),
          ]);
          yield* (yield* Deferred.await(subscribed)).shutdownHook.await;
          yield* Deferred.await(readClosed);
          assertBufferFull(yield* Fiber.join(reader));
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
          yield* PubSub.publish(pubsub, event(4, "after overflow"));
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
        })
      )
  );

  it.effect.each(["items", "bytes"] as const)(
    "counts an unacknowledged replay batch toward the live %s limit",
    (limit) =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();

          const subscribed = yield* Deferred.make<PubSub.Subscription<Event>>();

          const replayed = event(1, "replay");
          const live = event(2, "live");

          const pull = yield* Stream.toPull(
            replayAndBuffer(
              {
                subscribe: PubSub.subscribe(pubsub).pipe(
                  Effect.tap((subscription) =>
                    Deferred.succeed(subscribed, subscription)
                  )
                ),
                latestSequence: Effect.succeed(1),
                replay: () => Stream.succeed(replayed),
              },
              limit === "items"
                ? limits({ maxItems: 1 })
                : limits({
                    maxSerializedBytes:
                      Buffer.byteLength(JSON.stringify(replayed)) + 10,
                  })
            )
          );

          assert.deepStrictEqual(yield* pull, [replayed]);
          yield* PubSub.publish(pubsub, live);
          yield* (yield* Deferred.await(subscribed)).shutdownHook.await;
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
          assertBufferFull(yield* pull.pipe(Effect.result));
        })
      )
  );

  it.effect(
    "lets a fast reader replay a database page larger than both buffer limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();

          const events = Array.from({ length: 20 }, (_, index) =>
            event(index + 1, "historical event")
          );

          const replayed = yield* replayAndBuffer(
            {
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: Effect.succeed(20),
              replay: () => Stream.fromIterable(events),
            },
            limits({ maxItems: 2, maxSerializedBytes: 100 })
          ).pipe(Stream.take(20), Stream.runCollect);

          assert.deepStrictEqual(replayed, events);
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
        })
      )
  );

  it.effect(
    "filters unrelated events before buffering and deduplicates the replay/live overlap",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();
          const highWaterStarted = yield* Deferred.make<true>();
          const highWater = yield* Deferred.make<number>();
          const first = event(1, "first");
          const overlap = event(2, "overlap");
          const last = event(10, "last");

          const reader = yield* replayAndBuffer(
            {
              subscribe: PubSub.subscribe(pubsub),
              latestSequence: Deferred.succeed(highWaterStarted, true).pipe(
                Effect.andThen(Deferred.await(highWater))
              ),
              replay: () => Stream.make(first, overlap),
              filter: (candidate) => candidate.threadId === "selected",
            },
            limits({ maxItems: 4 })
          ).pipe(Stream.take(3), Stream.runCollect, Effect.forkScoped);

          yield* Deferred.await(highWaterStarted);
          yield* PubSub.publishAll(pubsub, [
            overlap,
            ...Array.from({ length: 6 }, (_, index) =>
              event(index + 3, "unrelated", "other")
            ),
            last,
          ]);
          yield* Deferred.succeed(highWater, 2);
          assert.deepStrictEqual(yield* Fiber.join(reader), [
            first,
            overlap,
            last,
          ]);
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
        })
      )
  );

  it.effect(
    "caps raw and projected stages while projection and client acknowledgement are blocked",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const pubsub = yield* PubSub.unbounded<Event>();

          const subscribed = yield* Deferred.make<PubSub.Subscription<Event>>();

          const projectionStarted = yield* Deferred.make<true>();
          const projectionClosed = yield* Deferred.make<true>();
          const releaseProjection = yield* Deferred.make<true>();

          const source = replayAndBuffer(
            {
              subscribe: PubSub.subscribe(pubsub).pipe(
                Effect.tap((subscription) =>
                  Deferred.succeed(subscribed, subscription)
                )
              ),
              latestSequence: Effect.succeed(0),
              replay: () => Stream.empty,
            },
            limits({ maxItems: 2 })
          ).pipe(
            Stream.mapEffect((item) =>
              item.sequence === 3
                ? Deferred.succeed(projectionStarted, true).pipe(
                    Effect.andThen(Deferred.await(releaseProjection)),
                    Effect.as(item)
                  )
                : Effect.succeed(item)
            ),
            Stream.ensuring(Deferred.succeed(projectionClosed, true))
          );

          const pull = yield* Stream.toPull(
            bufferLiveStream(source, limits({ maxItems: 2 }))
          );

          const firstPull = yield* pull.pipe(Effect.forkScoped);
          const subscription = yield* Deferred.await(subscribed);

          yield* PubSub.publish(pubsub, event(1, "awaiting ACK"));
          assert.deepStrictEqual(yield* Fiber.join(firstPull), [
            event(1, "awaiting ACK"),
          ]);
          yield* PubSub.publish(pubsub, event(2, "projected tail"));
          yield* PubSub.publish(pubsub, event(3, "projecting"));
          yield* Deferred.await(projectionStarted);
          yield* PubSub.publishAll(pubsub, [
            event(4, "raw tail"),
            event(5, "overflow"),
          ]);
          yield* subscription.shutdownHook.await;
          assert.strictEqual(yield* PubSub.size(pubsub), 0);
          yield* Deferred.succeed(releaseProjection, true);
          yield* Deferred.await(projectionClosed);
          assertBufferFull(yield* pull.pipe(Effect.result));
        })
      )
  );
});
