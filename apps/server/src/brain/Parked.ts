// Tasks the crash-loop guard parked. pi-durable parks a task that a crash cut off five times in a
// row without new state (`restart_limit`); it reports `task_parked` once and then waits for
// `retryTask()`. Cairn surfaces each one on its thread and offers "retry". This list is filled from
// the Harness's reports while it runs and from `inspect()` at boot, and a retry clears the entry.
//
// The retry flow follows spikes/3-workflows/brain.ts (`/retry`) in this repo.

import { ConversationId, TaskId } from "@cairn/protocol/Ids";
import { Context, Effect, Layer, PubSub, Ref, Schema, Stream } from "effect";

/** One parked task and the conversation it belongs to. */
export const ParkedTask = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  /** The task's registered name, such as `pi.tool` or `pi.generation`. */
  kind: Schema.String,
});

export type ParkedTask = typeof ParkedTask.Type;

/** The parked tasks the brain knows of. */
export class Parked extends Context.Service<
  Parked,
  {
    /** Records a parked task; a repeat for the same task changes nothing. */
    add(task: ParkedTask): Effect.Effect<void>;
    /** Forgets a task after it was retried or ended. */
    remove(taskId: TaskId): Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<ParkedTask>>;
    /** Each task as it is first parked. */
    readonly parked: Stream.Stream<ParkedTask>;
  }
>()("cairn/server/brain/Parked") {
  static readonly layer = Layer.effect(
    Parked,
    Effect.gen(function* () {
      const tasks = yield* Ref.make<ReadonlyMap<number, ParkedTask>>(new Map());
      const announcements = yield* PubSub.unbounded<ParkedTask>();

      const add = Effect.fn("Parked.add")(function* (task: ParkedTask) {
        const isNew = yield* Ref.modify(tasks, (current) =>
          current.has(task.taskId)
            ? [false, current]
            : [true, new Map(current).set(task.taskId, task)]
        );

        if (isNew) {
          yield* PubSub.publish(announcements, task);
        }
      });

      const remove = Effect.fn("Parked.remove")(function* (taskId: TaskId) {
        yield* Ref.update(tasks, (current) => {
          if (!current.has(taskId)) {
            return current;
          }

          const next = new Map(current);

          next.delete(taskId);

          return next;
        });
      });

      return Parked.of({
        add,
        remove,
        list: Effect.map(Ref.get(tasks), (current) => [...current.values()]),
        parked: Stream.fromPubSub(announcements),
      });
    })
  );
}
