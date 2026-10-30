import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref } from "effect";

import { Notifier } from "../push/Notifier.ts";
import type { PushMessage } from "../push/Notifier.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import {
  WorkflowBudgetPush,
  workflowPushMessage,
  WorkflowPushes,
} from "./WorkflowPushes.ts";

const THREAD = "0190a5f0-0000-7000-8000-000000000001";

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
});
