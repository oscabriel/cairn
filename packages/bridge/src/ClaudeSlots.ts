// The generation semaphore (plan D8): at most `size` Claude Code children generate at once. A child
// held across a tool call holds no permit, so a parent waiting on a subagent never holds the slot
// its child needs. The usage service resizes it (2F, in its own layer); the shell reads who waits.

import { Context, Effect, Layer, PubSub, Ref, Semaphore, Stream } from "effect";

/** The generation permits a fresh bridge starts with. */
export const DEFAULT_SLOTS = 4;

const without = (list: ReadonlyArray<string>, id: string) => {
  const index = list.indexOf(id);

  return index === -1 ? list : list.toSpliced(index, 1);
};

/** A conversation started or stopped waiting for a permit. */
export interface SlotWait {
  readonly sessionId: string;
  readonly waiting: boolean;
}

/** Generation permits for Claude Code children, counted per pi provider session id. */
export class ClaudeSlots extends Context.Service<
  ClaudeSlots,
  {
    /** Takes a permit for `sessionId`, waiting (and reporting the wait) while every permit is taken. */
    acquire(sessionId: string): Effect.Effect<void>;
    /** Returns one permit `sessionId` holds. */
    release(sessionId: string): Effect.Effect<void>;
    /** The number of permits. */
    readonly size: Effect.Effect<number>;
    /** Sets the number of permits; a shrink takes effect as children finish. */
    resize(permits: number): Effect.Effect<void>;
    /** Session ids waiting for a permit now. */
    readonly waiting: Effect.Effect<ReadonlyArray<string>>;
    /** Session ids holding a permit now, once per permit. */
    readonly generating: Effect.Effect<ReadonlyArray<string>>;
    /** Every change in who waits. */
    readonly waits: Stream.Stream<SlotWait>;
  }
>()("cairn/bridge/ClaudeSlots") {
  /** The semaphore with `DEFAULT_SLOTS` permits. */
  static readonly layer: Layer.Layer<ClaudeSlots> = Layer.effect(
    ClaudeSlots,
    Effect.gen(function* () {
      let permits = DEFAULT_SLOTS;

      const semaphore = yield* Semaphore.make(permits);
      const waitingRef = yield* Ref.make<ReadonlyArray<string>>([]);
      const holders = yield* Ref.make<ReadonlyArray<string>>([]);
      const changes = yield* PubSub.unbounded<SlotWait>();

      const setWaiting = (sessionId: string, waiting: boolean) =>
        Effect.andThen(
          Ref.update(waitingRef, (list) =>
            waiting ? [...list, sessionId] : without(list, sessionId)
          ),
          PubSub.publish(changes, { sessionId, waiting })
        );

      const acquire = Effect.fn("ClaudeSlots.acquire")(function* (
        sessionId: string
      ) {
        const immediate = yield* Semaphore.takeIfAvailable(semaphore, 1);

        // Interruptible only while it waits: a permit taken is always recorded, so a caller that
        // races the wait against an abort cannot lose one (T13).
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (!immediate) {
              yield* setWaiting(sessionId, true);
              yield* restore(Semaphore.take(semaphore, 1)).pipe(
                Effect.ensuring(setWaiting(sessionId, false))
              );
            }

            yield* Ref.update(holders, (list) => [...list, sessionId]);
          })
        );
      });

      const release = Effect.fn("ClaudeSlots.release")(function* (
        sessionId: string
      ) {
        const held = yield* Ref.modify(holders, (list) =>
          list.includes(sessionId)
            ? [true, without(list, sessionId)]
            : [false, list]
        );

        if (held) {
          yield* Semaphore.release(semaphore, 1);
        }
      });

      const resize = Effect.fn("ClaudeSlots.resize")(function* (size: number) {
        permits = Math.max(1, Math.trunc(size));
        yield* Semaphore.resize(semaphore, permits);
      });

      return ClaudeSlots.of({
        acquire,
        release,
        size: Effect.sync(() => permits),
        resize,
        waiting: Ref.get(waitingRef),
        generating: Ref.get(holders),
        waits: Stream.fromPubSub(changes),
      });
    })
  );
}
