// The soft line's push (workflows note W5, plan 5B): the budget reactor's push task
// (`cairn.workflow-budget-push`, WorkflowBudget.ts) runs inside the brain, which is built before
// the notifier, so it hands each push to `WorkflowPushes`, an outbox both sides share (one
// reference, as `BudgetBook.layer` is shared), and `WorkflowBudgetPush` sends what lands there
// through the `Notifier` as 4E's thread budgets do: the thread's title, the notice's words, the
// thread's budget tag, and the badge. A push whose thread is unknown goes out titled "Workflow
// budget" and opens the app.

import { badgeOf } from "@cairn/client-logic/Badge";
import { ThreadId } from "@cairn/protocol/Ids";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";

import { cutText, Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import type { WorkflowBudgetPush as Push } from "./WorkflowBudget.ts";

/** How long a push's title and body may be (BudgetGuard's). */
const TITLE_LIMIT = 80;

const BODY_LIMIT = 240;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The outbox between the brain's push task and the notifier. */
export class WorkflowPushes extends Context.Service<
  WorkflowPushes,
  {
    /** Hands one push over; never waits for its delivery. */
    send(push: Push): Effect.Effect<void>;
    /** Every push handed over, in order. Read by one consumer only. */
    readonly pushes: Stream.Stream<Push>;
  }
>()("cairn/server/workflows/WorkflowPushes") {
  /** One outbox; provide this reference to both sides so they share it. */
  static readonly layer = Layer.effect(
    WorkflowPushes,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Push>();

      return WorkflowPushes.of({
        send: (push) => Queue.offer(queue, push).pipe(Effect.asVoid),
        pushes: Stream.fromQueue(queue),
      });
    })
  );
}

/** The push message for `push`, titled by its thread's row when there is one. */
export const workflowPushMessage = (
  push: Push,
  title: Option.Option<string>,
  badge: number
): PushMessage => {
  const threadId = decodeThreadId(push.threadId);

  return {
    title: cutText(
      Option.getOrElse(title, () => "Workflow budget"),
      TITLE_LIMIT
    ),
    body: cutText(push.text, BODY_LIMIT),
    tag: Option.match(threadId, {
      onNone: () => `budget:workflow:${push.workflowId}`,
      onSome: (id) => `budget:${id}`,
    }),
    url: Option.match(threadId, {
      onNone: () => "/",
      onSome: (id) => `/t/${id}`,
    }),
    badge,
  };
};

/**
 * Sends each push the outbox carries, for as long as the app runs. Needs `WorkflowPushes`,
 * `Notifier` and `ThreadRows`.
 */
export const WorkflowBudgetPush = Layer.effectDiscard(
  Effect.gen(function* () {
    const outbox = yield* WorkflowPushes;
    const notifier = yield* Notifier;
    const threads = yield* ThreadRows;

    const badge = threads.listLive.pipe(
      Effect.map((rows) => badgeOf(rows.map((row) => row.shell))),
      Effect.orElseSucceed(() => 0)
    );

    const titleOf = (threadId: string) =>
      Option.match(decodeThreadId(threadId), {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (id) =>
          threads.get(id).pipe(
            Effect.map(Option.map((row) => row.shell.title)),
            Effect.orElseSucceed(() => Option.none<string>())
          ),
      });

    yield* outbox.pushes.pipe(
      Stream.runForEach((push) =>
        Effect.gen(function* () {
          const message = workflowPushMessage(
            push,
            yield* titleOf(push.threadId),
            yield* badge
          );

          yield* notifier.sendToAll(message);
        })
      ),
      Effect.forkScoped
    );
  })
);
