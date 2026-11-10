// Cairn's own crash accounting (ADR 0046). pi-durable counts each time a crash cuts a running task
// off without the task committing a new state (`TaskRecord.restarts`), and at its `restartLimit`
// ends the task. A wait that lives in a running invocation never commits a new state: a gated tool
// call waiting on its approval (ADR 0013) is a `pi.tool` task whose `execute` waits in memory, and
// a tool has no durable wait or sleep of its own. So pi-durable's limit would end a pending
// approval after five crashes, and the user's answer would find nothing to run.
//
// The brain opens the Harness with `restartLimit` set to `RestartLimit` (infinite,
// `RestartLimit.ts`), so pi-durable never ends a task for crashes, and boot's `crash limit` repair
// does the accounting instead, after open and before resume: every live task cut off `CRASH_LIMIT`
// times in a row is aborted, so it ends visibly through its own abort handler, except the waits
// Cairn keeps however often the brain dies:
//
// - every tool call (`pi.tool`). Cairn's waits are tool calls: an approval, a question, a
//   subagent wait, a workflow's script call and its nodes. A tool that is not replay-safe never
//   runs again after a crash (pi-durable ends it `interrupted`), and a gated one never runs its
//   effect twice (`Permissions.ts`), so what a tool call reruns is a wait or a read;
// - the task kinds a caller names (`keptKinds`): the subagent and workflow tasks that wait on other
//   work, a clock or a person (`BootRepairs.ts` lists them).
//
// What it ends is work that may itself be what crashes the brain: a generation (pi-durable already
// charges a request a crash cut off as a failed attempt), a compaction, and Cairn's other task
// kinds. An abort mark starts pi-durable's count over, so an aborted task's abort handler gets its
// own `CRASH_LIMIT` runs before the next boot would look at it again; a task already marked is
// left as it is.

import type { TaskRecord } from "@earendil-works/pi-durable";
import { DEFAULT_RESTART_LIMIT } from "@earendil-works/pi-durable";
import { Effect, Option } from "effect";

import { Brain } from "./Brain.ts";
import { durable } from "./Durable.ts";

/** How many crashes in a row Cairn lets a task take before boot ends it: pi-durable's default. */
export const CRASH_LIMIT = DEFAULT_RESTART_LIMIT;

/** The built-in tool call task's name: every tool call is a wait Cairn keeps. */
export const TOOL_TASK = "pi.tool";

/** What the accounting reads of one live task. */
export type CountedTask = Pick<
  TaskRecord<unknown, unknown, unknown>,
  "id" | "kind" | "conversationId" | "abortRequested" | "restarts"
>;

/**
 * The live tasks boot ends: cut off `CRASH_LIMIT` times in a row, not yet marked, and neither a
 * tool call nor of a kind in `keptKinds` (module header). Pure, so the rule is tested without a
 * brain.
 */
export const crashLooped = (
  tasks: ReadonlyArray<CountedTask>,
  keptKinds: ReadonlySet<string>
): ReadonlyArray<CountedTask> =>
  tasks.filter(
    (task) =>
      !task.abortRequested &&
      (task.restarts ?? 0) >= CRASH_LIMIT &&
      task.kind !== TOOL_TASK &&
      !keptKinds.has(task.kind)
  );

/**
 * Boot's crash accounting (module header): aborts every crash-looped task, after the Harness opens
 * and before it resumes. `abortTask` only marks a task; nothing runs until boot resumes the
 * Harness. Nothing without pi-durable (the scripted harness never crashes).
 */
export const endCrashLoopedTasks = (keptKinds: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(Brain);

    if (Option.isNone(found)) {
      return;
    }

    const { harness } = yield* found.value.session;

    const inspection = yield* durable(
      "inspect",
      async (context) => await harness.inspect(context)
    );

    const records = inspection.tasks.map((task) => task.record);
    const looped = crashLooped(records, keptKinds);

    // Every live task at or past the limit, kept ones included: how far the crashes went.
    const cutOff = records.filter(
      (task) => (task.restarts ?? 0) >= CRASH_LIMIT
    ).length;

    for (const task of looped) {
      yield* durable("abort-task", async (context) => {
        await harness.abortTask(task.id, context);
      }).pipe(
        Effect.tapError((failure) =>
          Effect.logWarning("crash-looped task was not ended").pipe(
            Effect.annotateLogs({
              event: "boot_crash_limit_failed",
              taskId: task.id,
              error: failure.message,
            })
          )
        ),
        Effect.ignore
      );

      yield* Effect.logWarning("crash-looped task ended").pipe(
        Effect.annotateLogs({
          event: "boot_crash_limit",
          taskId: task.id,
          task: task.kind,
          conversationId: task.conversationId,
          restarts: task.restarts ?? 0,
        })
      );
    }

    yield* Effect.logInfo(`ended ${looped.length} crash-looped tasks`).pipe(
      Effect.annotateLogs({
        event: "boot_crash_limit_done",
        ended: looped.length,
        cutOff,
      })
    );
  });
