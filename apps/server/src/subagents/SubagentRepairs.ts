// The subagents extension's boot repairs (ADR 0028), handed to `BootRepairs.ts` after
// `retry-parked-approval-waits`:
//
// - `subagent-rows` (SubagentRows.ts): a shell row for every child conversation without one.
// - `subagent-routes`: a child's question to its parent is re-offered by its own `ask_parent` task,
//   which reruns after a restart (`replay: "safe"`) and submits the parent's note under the same
//   request id; a wait parked by the crash-loop guard is a pending record in the child's own
//   `cairn.approvals`, so `retry-parked-approval-waits` already retries it. Nothing more is needed.
// - `subagent-tasks`: the reporter and brief tasks are background tasks of the parent and wait in
//   memory (a reporter on its child's submission, a brief task on Go), so five crashes park them
//   like an approval wait (ADR 0013's hole). A parent with no pending approval of its own is not
//   reached by the approval repair, so every parked subagent task is retried here. The anchor
//   completes in its first phase and never waits, so it is not among them.

import type { TaskId } from "@earendil-works/pi-durable";
import { Effect, Option } from "effect";

import { Brain } from "../brain/Brain.ts";
import { durable } from "../brain/Durable.ts";
import { SUBAGENT_TASKS } from "./SubagentTasks.ts";

/** One task as the parked filter reads it: a part of pi-durable's `TaskInspection`. */
export interface InspectedTask {
  readonly record: { readonly id: TaskId; readonly kind: string };
  readonly state: { readonly kind: string; readonly reason?: string };
}

/** The subagent tasks among `tasks` the crash-loop guard parked, in their order. */
export const parkedSubagentTasks = (
  tasks: ReadonlyArray<InspectedTask>
): ReadonlyArray<TaskId> =>
  tasks.flatMap(({ record, state }) =>
    SUBAGENT_TASKS.has(record.kind) &&
    state.kind === "blocked" &&
    state.reason === "restart_limit"
      ? [record.id]
      : []
  );

/** Retries every subagent task the crash-loop guard parked. Nothing without pi-durable. */
export const retryParkedSubagentTasks = Effect.gen(function* () {
  const found = yield* Effect.serviceOption(Brain);

  if (Option.isNone(found)) {
    return;
  }

  const { harness } = yield* found.value.session;

  const inspection = yield* durable(
    "inspect",
    async (context) => await harness.inspect(context)
  );

  const parked = parkedSubagentTasks(inspection.tasks);

  for (const taskId of parked) {
    yield* durable("retry-task", async (context) => {
      await harness.retryTask(taskId, context);
    }).pipe(
      Effect.tapError((failure) =>
        Effect.logWarning("parked subagent task was not retried").pipe(
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

  yield* Effect.logInfo(`retried ${parked.length} parked subagent tasks`).pipe(
    Effect.annotateLogs({
      event: "boot_retried_subagent_tasks",
      retried: parked.length,
    })
  );
});
