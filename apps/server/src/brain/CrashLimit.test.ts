// Boot's crash accounting (ADR 0046): which live tasks crashes cut off too often end, and which
// waits Cairn keeps however often the brain dies. The rule is pure (`crashLooped`); the kill judge
// (`judges/approval-kill.ts`) shows it on a real brain.

import { assert, describe, it } from "@effect/vitest";

import { conversationOf, taskOf } from "../subagents/Delivery.ts";
import { CRASH_LIMIT, crashLooped, TOOL_TASK } from "./CrashLimit.ts";
import type { CountedTask } from "./CrashLimit.ts";

const task = (
  id: number,
  kind: string,
  restarts: number,
  abortRequested = false
): CountedTask => ({
  id: taskOf(id),
  kind,
  conversationId: conversationOf(1),
  abortRequested,
  restarts,
});

const ids = (tasks: ReadonlyArray<CountedTask>) =>
  tasks.map(({ id }) => Number(id));

const KEPT = new Set(["cairn.subagent-reporter"]);

describe("the crash accounting", () => {
  it("ends work cut off the limit's number of times, and none below it", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(1, "pi.generation", CRASH_LIMIT),
            task(2, "pi.compaction", CRASH_LIMIT - 1),
            task(3, "cairn.judge-run", CRASH_LIMIT + 3),
          ],
          KEPT
        )
      ),
      [1, 3]
    );
  });

  it("keeps every tool call, the approval waits among them, however often crashes cut it off", () => {
    assert.deepStrictEqual(
      ids(crashLooped([task(12, TOOL_TASK, CRASH_LIMIT * 20)], KEPT)),
      []
    );
  });

  it("keeps the kinds it is told to, and leaves a task already marked for abort", () => {
    assert.deepStrictEqual(
      ids(
        crashLooped(
          [
            task(1, "cairn.subagent-reporter", CRASH_LIMIT * 4),
            task(2, "pi.generation", CRASH_LIMIT, true),
          ],
          KEPT
        )
      ),
      []
    );
  });
});
