import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import {
  LETTER_WINDOW,
  WorkflowBudgetPush,
  workflowPushMessage,
  WorkflowPushes,
} from "./WorkflowPushes.ts";

const THREAD = "0190a5f0-0000-7000-8000-000000000001";

/** A dead letter of `reactor` for event `eventId`. */
const letter = (reactor: string, eventId: number) => ({
  reactor,
  eventId,
  kind: "event.workflow.budget.soft",
  error: `cannot read ${String(eventId)}`,
});

describe("workflow budget pushes", () => {
  it("words a push from its thread, or from the run when the thread is unknown", () => {
    const known = workflowPushMessage(
      {
        threadId: THREAD,
        workflowId: "wf-1",
        text: "Workflow w has used 80%.",
      },
      Option.some("Refactor"),
      2
    );

    assert.deepStrictEqual(known, {
      title: "Refactor",
      body: "Workflow w has used 80%.",
      tag: `budget:${THREAD}`,
      url: `/t/${THREAD}`,
      badge: 2,
    });

    const unknown = workflowPushMessage(
      { threadId: "", workflowId: "wf-1", text: "used" },
      Option.none(),
      0
    );

    assert.strictEqual(unknown.title, "Workflow budget");
    assert.strictEqual(unknown.tag, "budget:workflow:wf-1");
    assert.strictEqual(unknown.url, "/");
  });

  it.live(
    "sends each push handed to the outbox through the notifier, once",
    () =>
      Effect.gen(function* () {
        const sent = yield* Ref.make<ReadonlyArray<PushMessage>>([]);

        const fakes = Layer.mergeAll(
          Layer.mock(Notifier)({
            sendToAll: (message) =>
              Ref.update(sent, (all) => [...all, message]).pipe(
                Effect.as(["delivered" as const])
              ),
          }),
          Layer.mock(ThreadRows)({
            get: () => Effect.succeedNone,
            listLive: Effect.succeed([]),
          })
        );

        yield* Effect.gen(function* () {
          const outbox = yield* WorkflowPushes;

          yield* outbox.send({ threadId: "", workflowId: "wf-1", text: "a" });
          yield* outbox.send({ threadId: "", workflowId: "wf-2", text: "b" });
          yield* Effect.sleep("30 millis");
        }).pipe(
          Effect.provide(
            WorkflowBudgetPush.pipe(
              Layer.provideMerge(WorkflowPushes.layer),
              Layer.provide(fakes)
            )
          )
        );

        const messages = yield* Ref.get(sent);

        assert.deepStrictEqual(
          messages.map((message) => message.body),
          ["a", "b"]
        );
      })
  );

  it.effect(
    "pushes every dead letter, a reactor's letters within the window as one push that counts them",
    () =>
      Effect.gen(function* () {
        const sent = yield* Ref.make<ReadonlyArray<PushMessage>>([]);

        const fakes = Layer.mergeAll(
          Layer.mock(Notifier)({
            sendToAll: (message) =>
              Ref.update(sent, (all) => [...all, message]).pipe(
                Effect.as(["delivered" as const])
              ),
          }),
          Layer.mock(ThreadRows)({
            get: () => Effect.succeedNone,
            listLive: Effect.succeed([]),
          })
        );

        yield* Effect.gen(function* () {
          const outbox = yield* WorkflowPushes;

          // A run of three from one reactor and one from another, then, a window later, one more.
          for (const each of [
            letter("budget", 1),
            letter("budget", 2),
            letter("other", 3),
            letter("budget", 4),
          ]) {
            yield* outbox.sendDeadLetter(each);
          }

          yield* Effect.yieldNow;
          yield* TestClock.adjust(LETTER_WINDOW);
          yield* outbox.sendDeadLetter(letter("budget", 5));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(LETTER_WINDOW);
          yield* Effect.yieldNow;
        }).pipe(
          Effect.provide(
            WorkflowBudgetPush.pipe(
              Layer.provideMerge(WorkflowPushes.layer),
              Layer.provide(fakes)
            )
          )
        );

        const messages = yield* Ref.get(sent);

        assert.deepStrictEqual(
          messages.map((message) => [message.title, message.tag, message.body]),
          [
            [
              "3 events were skipped",
              "dead-letter:budget",
              "budget could not handle event 4 (event.workflow.budget.soft) and passed it, with 2 more: cannot read 4",
            ],
            [
              "An event was skipped",
              "dead-letter:other",
              "other could not handle event 3 (event.workflow.budget.soft) and passed it: cannot read 3",
            ],
            [
              "An event was skipped",
              "dead-letter:budget",
              "budget could not handle event 5 (event.workflow.budget.soft) and passed it: cannot read 5",
            ],
          ]
        );
      })
  );
});
