// Scene tests for the banner above an open thread: a parked task's Retry calls `thread.retryTask`,
// a thread waiting for a Claude slot says so, and a spent plan window reads "Limited" with its reset.

import { ProjectId, TaskId, ThreadId } from "@cairn/protocol/Ids";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import type { RetryTaskInput } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option } from "effect";
import * as Scene from "foldkit/scene";

import { formatDayTime } from "../settings/Time.ts";
import {
  initial,
  inform,
  Message,
  RetryParkedTask,
  retryParkedTask,
  update,
  view,
} from "./Parked.ts";
import type { Model } from "./Parked.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const threadId = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const taskId = TaskId.make(7);

const thread = ThreadShell.make({
  id: threadId,
  projectId: ProjectId.make("prj_cairn"),
  title: "Bridge held resume",
  provider: "claude-bridge",
  modelId: "claude-haiku-5-5",
  thinkingLevel: "medium",
  runtimeMode: "full-access",
  branch: Option.none(),
  worktreePath: Option.none(),
  activity: "idle",
  activeRunId: Option.none(),
  latestRunRequestedAt: Option.none(),
  latestRunStartedAt: Option.none(),
  latestRunCompletedAt: Option.none(),
  queueLength: 0,
  lastError: Option.none(),
  lastErrorClass: Option.none(),
  usageLimitResetAt: Option.none(),
  waitingFor: "none",
  pendingRuntimeRequest: Option.none(),
  latestVisibleMessage: Option.none(),
  latestUserMessageAt: Option.none(),
  createdAt: time("2026-10-22T09:00:00Z"),
  updatedAt: time("2026-10-22T09:00:00Z"),
  archivedAt: Option.none(),
  settledOverride: Option.none(),
  settledAt: Option.none(),
  unsettledAt: Option.none(),
  snoozedUntil: Option.none(),
  snoozedAt: Option.none(),
  pinnedAt: Option.none(),
  pinOrderKey: Option.none(),
  activeOrderKey: Option.none(),
  autoSettleDisabledAt: Option.none(),
  lastVisitedAt: Option.none(),
  parkedTaskIds: [],
  ...BARE_ROW_FIELDS,
});

const showing = (shell: ThreadShell): Model =>
  inform(initial, { thread: Option.some(shell), hasClient: true }).model;

const config = { update, view };

describe("the thread hold banner", () => {
  it("retries a parked task through thread.retryTask", () => {
    Scene.scene(
      config,
      Scene.given(
        showing({ ...thread, activity: "parked", parkedTaskIds: [taskId] })
      ),
      Scene.expect(Scene.testId("thread-hold")).toContainText("Parked"),
      Scene.click(Scene.role("button", { name: "Retry" })),
      Scene.Command.resolve(
        RetryParkedTask({ threadId, taskId }),
        Message.SucceededRetry()
      ),
      Scene.expect(Scene.role("button", { name: "Retry" })).toBeEnabled(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it.effect("sends the thread and task to the brain's retryTask", () =>
    Effect.gen(function* () {
      const calls: Array<RetryTaskInput> = [];

      const client = {
        "thread.retryTask": (input: RetryTaskInput) =>
          Effect.sync(() => {
            calls.push(input);
          }),
      };

      const answer = yield* retryParkedTask(client, { threadId, taskId });

      assert.deepStrictEqual(calls, [{ threadId, taskId }]);
      assert.deepStrictEqual(answer, Message.SucceededRetry());
    })
  );

  it("shows the brain's reason when the retry fails", () => {
    Scene.scene(
      config,
      Scene.given(
        showing({ ...thread, activity: "parked", parkedTaskIds: [taskId] })
      ),
      Scene.click(Scene.role("button", { name: "Retry" })),
      Scene.Command.resolve(
        RetryParkedTask({ threadId, taskId }),
        Message.FailedRetry({ message: "The brain is closing." })
      ),
      Scene.expect(Scene.testId("thread-hold")).toContainText(
        "The brain is closing."
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says a thread is waiting for a Claude slot", () => {
    Scene.scene(
      config,
      Scene.given(
        showing({ ...thread, activity: "waiting", waitingFor: "claude_slot" })
      ),
      Scene.expect(Scene.testId("thread-hold")).toContainText(
        "waiting for a Claude slot"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("reads Limited with the reset time for a spent plan window", () => {
    const resetsAt = time("2026-10-22T15:00:00Z");

    Scene.scene(
      config,
      Scene.given(
        showing({
          ...thread,
          activity: "failed",
          lastErrorClass: Option.some("usage_limit"),
          lastError: Option.some("Claude plan quota exceeded"),
          usageLimitResetAt: Option.some(resetsAt),
        })
      ),
      Scene.expect(
        Scene.within(Scene.testId("thread-hold"), Scene.text("Limited"))
      ).toExist(),
      Scene.expect(Scene.testId("thread-hold")).toContainText(
        `resets ${formatDayTime(resetsAt)}`
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows nothing for a thread that is not held", () => {
    Scene.scene(
      config,
      Scene.given(showing(thread)),
      Scene.expect(Scene.testId("thread-hold")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
