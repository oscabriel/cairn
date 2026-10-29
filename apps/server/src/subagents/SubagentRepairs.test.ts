// The parked-task repair's filter (SubagentRepairs.ts): of the tasks pi-durable's inspection lists,
// only the subagent reporter and brief tasks the crash-loop guard parked are retried; a parked task
// of another kind, a blocked task that threw, and a subagent task that is merely waiting are left.
// Parking itself takes five crashes in a row (`kill -9`), which 4C's durability judge drives.

import { TaskId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";

import { piTaskId } from "../brain/PiIds.ts";
import { parkedSubagentTasks } from "./SubagentRepairs.ts";
import type { InspectedTask } from "./SubagentRepairs.ts";
import { ANCHOR_TASK, BRIEF_TASK, REPORTER_TASK } from "./SubagentTasks.ts";

const task = (
  id: number,
  kind: string,
  state: InspectedTask["state"]
): InspectedTask => ({
  record: { id: piTaskId(TaskId.make(id)), kind },
  state,
});

const PARKED = { kind: "blocked", reason: "restart_limit" } as const;

describe("the parked subagent task repair", () => {
  it("retries the parked reporter and brief tasks and nothing else", () => {
    const tasks = [
      task(1, REPORTER_TASK, PARKED),
      task(2, "pi.run", PARKED),
      task(3, BRIEF_TASK, PARKED),
      task(4, REPORTER_TASK, { kind: "blocked", reason: "threw" }),
      task(5, REPORTER_TASK, { kind: "waiting" }),
      task(6, ANCHOR_TASK, { kind: "running" }),
    ];

    assert.deepStrictEqual(parkedSubagentTasks(tasks), [
      piTaskId(TaskId.make(1)),
      piTaskId(TaskId.make(3)),
    ]);
  });

  it("finds nothing to retry when no task is parked", () => {
    assert.deepStrictEqual(
      parkedSubagentTasks([task(1, REPORTER_TASK, { kind: "running" })]),
      []
    );
  });
});
