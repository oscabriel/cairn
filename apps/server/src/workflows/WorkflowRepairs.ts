// The workflows extension's boot repair (wave 4's held item), handed to `BootRepairs.ts` after
// `retry parked subagent tasks`: the watcher (`cairn.workflow-watch`) waits on a node's or a script
// call's task and records how it ended. It is a background task of the launching conversation, so
// five crashes park it like an approval wait (ADR 0013's hole), and a parked watcher leaves its node
// `running` and its workflow never ended. It starts no outside work and its record is idempotent
// (it writes only a row that has not ended), so each parked watcher is retried at boot. The node
// tools themselves are nested tool tasks of the script call, which the script's own task resumes.
//
// 5B's budget stopper is the same kind of task: it joins `WORKFLOW_TASKS` when it lands.

import type { TaskId } from "@earendil-works/pi-durable";
import { Effect, Option } from "effect";

import { Brain } from "../brain/Brain.ts";
import { durable } from "../brain/Durable.ts";
import type { InspectedTask } from "../subagents/SubagentRepairs.ts";
import { WATCH_TASK } from "./WorkflowTools.ts";

/** The workflow tasks a boot retries when parked. */
export const WORKFLOW_TASKS: ReadonlySet<string> = new Set([WATCH_TASK]);

/** The workflow tasks among `tasks` the crash-loop guard parked, in their order. */
export const parkedWorkflowTasks = (
  tasks: ReadonlyArray<InspectedTask>
): ReadonlyArray<TaskId> =>
  tasks.flatMap(({ record, state }) =>
    WORKFLOW_TASKS.has(record.kind) &&
    state.kind === "blocked" &&
    state.reason === "restart_limit"
      ? [record.id]
      : []
  );

/** Retries every workflow watcher the crash-loop guard parked. Nothing without pi-durable. */
export const retryParkedWorkflowTasks = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return;
  }

  const { harness } = yield* found.value.session;

  const inspection = yield* durable(
    "inspect",
    async (context) => await harness.inspect(context)
  );

  const parked = parkedWorkflowTasks(inspection.tasks);

  for (const taskId of parked) {
    yield* durable("retry-task", async (context) => {
      await harness.retryTask(taskId, context);
    }).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("parked workflow task was not retried").pipe(
          Effect.annotateLogs({
            event: "boot_retry_failed",
            taskId,
            error: failure.message,
          })
        )
      ),
      Effect.ignore
    );
  }

  yield* Effect.logInfo(`retried ${parked.length} parked workflow tasks`).pipe(
    Effect.annotateLogs({
      event: "boot_retried_workflow_tasks",
      retried: parked.length,
    })
  );
});
