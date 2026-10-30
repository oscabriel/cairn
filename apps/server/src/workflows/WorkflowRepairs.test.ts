// The parked watcher repair's filter (WorkflowRepairs.ts): of the tasks pi-durable's inspection
// lists, only the workflow watchers the crash-loop guard parked are retried; a parked task of
// another kind (the run, the script call, a node, which the user's Retry restarts), a blocked
// watcher that threw, and a watcher that is merely waiting are left. Parking itself takes five
// kills in a row, which `judges/workflow-kill.ts` drives in its `park-watcher` case.

import { TaskId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";

import { piTaskId } from "../brain/PiIds.ts";
import type { InspectedTask } from "../subagents/SubagentRepairs.ts";
import { parkedWorkflowTasks } from "./WorkflowRepairs.ts";
import { WATCH_TASK } from "./WorkflowTools.ts";

const task = (
  id: number,
  kind: string,
  state: InspectedTask["state"]
): InspectedTask => ({
  record: { id: piTaskId(TaskId.make(id)), kind },
  state,
});

const PARKED = { kind: "blocked", reason: "restart_limit" } as const;

describe("the parked workflow watcher repair", () => {
  it("retries the parked watchers and nothing else", () => {
    const tasks = [
      task(1, WATCH_TASK, PARKED),
      task(2, "pi.run", PARKED),
      task(3, "pi.tool", PARKED),
      task(4, WATCH_TASK, { kind: "blocked", reason: "threw" }),
      task(5, WATCH_TASK, { kind: "waiting" }),
      task(6, WATCH_TASK, PARKED),
    ];

    assert.deepStrictEqual(parkedWorkflowTasks(tasks), [
      piTaskId(TaskId.make(1)),
      piTaskId(TaskId.make(6)),
    ]);
  });

  it("finds nothing to retry when no watcher is parked", () => {
    assert.deepStrictEqual(
      parkedWorkflowTasks([task(1, WATCH_TASK, { kind: "running" })]),
      []
    );
  });
});
