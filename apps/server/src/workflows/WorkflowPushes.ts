// The soft line's push (workflows note W5, plan 5B): the budget reactor's push task
// (`cairn.workflow-budget-push`, WorkflowBudget.ts) runs inside the brain, which is built before
// the notifier, so it hands each push to `WorkflowPushes`, an outbox both sides share (one
// reference, as `BudgetBook.layer` is shared), and `WorkflowBudgetPush` sends what lands there
// through the `Notifier` as 4E's thread budgets do: the thread's title, the notice's words, the
// thread's budget tag, and the badge. A push whose thread is unknown goes out titled "Workflow
// budget" and opens the app.
//
// The same outbox carries the reactor host's dead letters (ADR 0033 as amended,
// `EventReactors.ts`): an event a reactor passed without handling it. Every letter is pushed: the
// letters of one reactor that land within `LETTER_WINDOW` of its first go out as one push that
// counts them, under one tag per reactor, so a run of bad events is one notification and none is
// left out.

import { badgeOf } from "@cairn/client-logic/Badge";
import { ThreadId } from "@cairn/protocol/Ids";
import { Context, Effect, Layer, Option, Queue, Schema, Stream } from "effect";
import type { Array as Arr } from "effect";

import { cutText, Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import type { WorkflowBudgetPush as Push } from "./WorkflowBudget.ts";

/** How long a push's title and body may be (BudgetGuard's). */
const TITLE_LIMIT = 80;

const BODY_LIMIT = 240;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** An event a reactor passed without handling it: which reactor, which event, and why. */
export interface DeadLetterPush {
  readonly reactor: string;
  readonly eventId: number;
  /** The event's entry kind, `event.<name>`. */
  readonly kind: string;
  readonly error: string;
}

/** The outbox between the brain's push task and the notifier. */
export class WorkflowPushes extends Context.Service<
  WorkflowPushes,
  {
    /** Hands one push over; never waits for its delivery. */
    send(push: Push): Effect.Effect<void>;
    /** Every push handed over, in order. Read by one consumer only. */
    readonly pushes: Stream.Stream<Push>;
    /** Hands one dead letter's push over; never waits for its delivery. */
    sendDeadLetter(letter: DeadLetterPush): Effect.Effect<void>;
    /** Every dead letter handed over, in order. Read by one consumer only. */
    readonly deadLetters: Stream.Stream<DeadLetterPush>;
  }
>()("cairn/server/workflows/WorkflowPushes") {
  /** One outbox; provide this reference to both sides so they share it. */
  static readonly layer = Layer.effect(
    WorkflowPushes,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Push>();
      const letters = yield* Queue.unbounded<DeadLetterPush>();

      return WorkflowPushes.of({
        send: (push) => Queue.offer(queue, push).pipe(Effect.asVoid),
        pushes: Stream.fromQueue(queue),
        sendDeadLetter: (letter) =>
          Queue.offer(letters, letter).pipe(Effect.asVoid),
        deadLetters: Stream.fromQueue(letters),
      });
    })
  );
}

/** How long the dead letters after a first one are gathered into its push. */
export const LETTER_WINDOW = "5 seconds";

/** The most dead letters one push counts; more in the window go out in the next. */
const LETTER_BATCH = 500;

/** The dead letters of a batch, one group per reactor, in the order each reactor first appears. */
export const lettersByReactor = (
  letters: ReadonlyArray<DeadLetterPush>
): ReadonlyArray<Arr.NonEmptyReadonlyArray<DeadLetterPush>> => {
  const groups = new Map<string, [DeadLetterPush, ...Array<DeadLetterPush>]>();

  for (const letter of letters) {
    const group = groups.get(letter.reactor);

    if (group === undefined) {
      groups.set(letter.reactor, [letter]);
    } else {
      group.push(letter);
    }
  }

  return [...groups.values()];
};

/**
 * The push message for one reactor's dead letters: the last one passed, and how many others with
 * it, under one tag per reactor.
 */
export const deadLetterMessage = (
  letters: Arr.NonEmptyReadonlyArray<DeadLetterPush>,
  badge: number
): PushMessage => {
  const last = letters.at(-1) ?? letters[0];
  const others = letters.length - 1;

  return {
    title:
      others === 0
        ? "An event was skipped"
        : `${String(letters.length)} events were skipped`,
    body: cutText(
      `${last.reactor} could not handle event ${String(last.eventId)} (${last.kind}) and passed it${others === 0 ? "" : `, with ${String(others)} more`}: ${last.error}`,
      BODY_LIMIT
    ),
    tag: `dead-letter:${last.reactor}`,
    url: "/",
    badge,
  };
};

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
 * Sends each push and dead letter the outbox carries, for as long as the app runs. Needs
 * `WorkflowPushes`, `Notifier` and `ThreadRows`.
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

    yield* outbox.deadLetters.pipe(
      Stream.groupedWithin(LETTER_BATCH, LETTER_WINDOW),
      Stream.runForEach((batch) =>
        Effect.flatMap(badge, (count) =>
          Effect.forEach(
            lettersByReactor(batch),
            (letters) => notifier.sendToAll(deadLetterMessage(letters, count)),
            { discard: true }
          )
        )
      ),
      Effect.forkScoped
    );
  })
);
