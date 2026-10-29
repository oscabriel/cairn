// The parked-task repair's filter (SubagentRepairs.ts): of the tasks pi-durable's inspection lists,
// only the subagent reporter, brief and tell tasks the crash-loop guard parked are retried; a parked
// task of another kind, a parked start task (ADR 0030: it waits for a human Retry on the parent), a
// blocked task that threw, and a subagent task that is merely waiting are left. Parking itself takes
// five crashes in a row (`kill -9`), which `judges/brief-go.sh` drives for the start task and 4C's
// durability judge for the reporter.

import { TaskId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";

import { piTaskId } from "../brain/PiIds.ts";
import { parkedSubagentTasks } from "./SubagentRepairs.ts";
import type { InspectedTask } from "./SubagentRepairs.ts";
import {
  ANCHOR_TASK,
  BRIEF_TASK,
  BRIEF_TELL_TASK,
  REPORTER_TASK,
  START_TASK,
} from "./SubagentTasks.ts";

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
  it("retries the parked reporter, brief and tell tasks and nothing else", () => {
    const tasks = [
      task(1, REPORTER_TASK, PARKED),
      task(2, "pi.run", PARKED),
      task(3, BRIEF_TASK, PARKED),
      task(4, REPORTER_TASK, { kind: "blocked", reason: "threw" }),
      task(5, REPORTER_TASK, { kind: "waiting" }),
      task(6, ANCHOR_TASK, { kind: "running" }),
      task(7, BRIEF_TELL_TASK, PARKED),
    ];

    assert.deepStrictEqual(parkedSubagentTasks(tasks), [
      piTaskId(TaskId.make(1)),
      piTaskId(TaskId.make(3)),
      piTaskId(TaskId.make(7)),
    ]);
  });

  it("leaves a parked start task for the parent's Retry", () => {
    assert.deepStrictEqual(
      parkedSubagentTasks([task(1, START_TASK, PARKED)]),
      []
    );
  });

  it("finds nothing to retry when no task is parked", () => {
    assert.deepStrictEqual(
      parkedSubagentTasks([task(1, REPORTER_TASK, { kind: "running" })]),
      []
    );
  });
});
