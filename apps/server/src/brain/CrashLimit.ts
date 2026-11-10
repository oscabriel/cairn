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
// times in a row is aborted, so it ends through its own abort handler (a tool call with an
// "aborted" result the model reads, a run as a stop ends it), except the waits Cairn keeps however
// often the brain dies (`KeptWaits`):
//
// - a tool call that waits (`toolWaits`): one that holds a record in its conversation's
//   `cairn.approvals` (`call-<task id>`, whatever its status: a gated call, `ask_user`,
//   `ask_parent`, `workflow_plan`, a workflow's `approve`, `agent` and `verify` nodes, an Executor
//   or portal call that asked), a workflow's script call (the row's `codemodeTaskId`), or a call of
//   a tool the caller names (`subagent_status`, which waits on its children and holds no record,
//   and a workflow's `agent` and `verify`, which hold none while they are queued for a node slot);
//   and every tool call above a kept one through its nested calls (a script waiting on its nested
//   call's approval). A kept call reruns only to wait again or to read its decision, and a gated
//   call's effect runs at most once by its effect mark (`Permissions.ts`). A code mode script
//   queued for a script slot is not kept: nothing durable says it never started, and it ends with
//   the "aborted" result the model reads;
// - the task kinds the caller names: the subagent and workflow tasks that wait on other work, a
//   clock or a person (`BootRepairs.ts` lists them).
//
// What it ends is work that may itself be what crashes the brain: a tool call that waits on
// nothing (a replay-safe read or script the brain dies in), a generation (pi-durable already
// charges a request a crash cut off as a failed attempt), a compaction, and Cairn's other task
// kinds. An abort mark starts pi-durable's count over, so an aborted task's abort handler gets its
// own `CRASH_LIMIT` runs before the next boot would look at it again; a task already marked is
// left as it is. The accounting runs once per process boot: a Session the supervisor reopens in the
// same process (`Brain.ts`) resumes without it.

import { EntryId } from "@cairn/protocol/Ids";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  ConversationId,
  Harness,
  TaskRecord,
} from "@earendil-works/pi-durable";
import { DEFAULT_RESTART_LIMIT } from "@earendil-works/pi-durable";
import { Effect, Function, Option, Schema } from "effect";

import { approvalIdOf } from "../approvals/ApprovalLedger.ts";
import { Brain } from "./Brain.ts";
import { Approvals } from "./CairnDocs.ts";
import { durable, errorText } from "./Durable.ts";
import { piEntryId } from "./PiIds.ts";
import { WorkflowsDoc } from "./WorkflowsDoc.ts";

/** How many crashes in a row Cairn lets a task take before boot ends it: pi-durable's default. */
export const CRASH_LIMIT = DEFAULT_RESTART_LIMIT;

/** The built-in tool call task's name. */
export const TOOL_TASK = "pi.tool";

/** What the accounting reads of one live task. */
export type CountedTask = Pick<
  TaskRecord<JsonValue, unknown, unknown>,
  | "id"
  | "kind"
  | "conversationId"
  | "abortRequested"
  | "restarts"
  | "owner"
  | "input"
>;

/** The waits boot keeps however often crashes cut them off (module header). */
export interface KeptWaits {
  /** Task kinds kept whole. */
  readonly kinds: ReadonlySet<string>;
  /** Tools whose calls wait without a record of their own. */
  readonly tools: ReadonlySet<string>;
}

/** What a tool call's task input names: the call itself for a nested call, its entry for a model's. */
const ToolInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("nested"),
    call: Schema.Struct({ name: Schema.String }),
  }),
  Schema.Struct({
    kind: Schema.Literal("model"),
    assistant: Schema.Finite,
    callId: Schema.String,
  }),
]);

const decodeToolInput = Schema.decodeUnknownOption(ToolInput);

/** The tool calls an assistant message holds: `{ type: "toolCall", id, name }` blocks. */
const AssistantCalls = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
});

const decodeAssistantCalls = Schema.decodeUnknownOption(AssistantCalls);

const decodeToolCall = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    id: Schema.String,
    name: Schema.String,
  })
);

/**
 * The nested tool calls that call one of `tools`, read from their task input alone (no store read):
 * a workflow's `agent` or `verify` call still queued for a node slot holds no record yet, and is
 * kept by its name. Pure, so the rule is tested without a brain.
 */
export const namedWaits = (
  tasks: ReadonlyArray<CountedTask>,
  tools: ReadonlySet<string>
): ReadonlySet<number> =>
  new Set(
    tasks.flatMap((task) => {
      const input = decodeToolInput(task.input);

      return task.kind === TOOL_TASK &&
        Option.isSome(input) &&
        input.value.kind === "nested" &&
        tools.has(input.value.call.name)
        ? [Number(task.id)]
        : [];
    })
  );

/** The name of the tool a tool call task calls; none when its entry cannot be read. */
const callName = async (
  harness: Harness,
  task: CountedTask,
  context: ChordContext
): Promise<Option.Option<string>> => {
  const input = decodeToolInput(task.input);

  if (Option.isNone(input)) {
    return Option.none();
  }

  if (input.value.kind === "nested") {
    return Option.some(input.value.call.name);
  }

  const { assistant, callId } = input.value;
  const entryId = piEntryId(EntryId.make(assistant));
  const conversation = await harness.conversation(task.conversationId, context);

  const page = await conversation?.entries(
    { minEntryId: entryId, maxEntryId: entryId },
    1,
    undefined,
    context
  );

  const [message] = page?.items[0]?.model ?? [];

  return Option.flatMap(decodeAssistantCalls(message), ({ content }) =>
    Option.map(
      Option.fromUndefinedOr(
        content
          .map((part) => decodeToolCall(part))
          .flatMap(Option.toArray)
          .find((call) => call.id === callId)
      ),
      (call) => call.name
    )
  );
};

/** `read` once per conversation: later calls for the same one share the first read. */
const perConversation = <A>(
  read: (conversationId: ConversationId) => Promise<A>
) => {
  const held = new Map<ConversationId, Promise<A>>();

  return async (conversationId: ConversationId): Promise<A> => {
    const known = held.get(conversationId);

    if (known !== undefined) {
      return await known;
    }

    const next = read(conversationId);

    held.set(conversationId, next);

    return await next;
  };
};

/**
 * The live tool calls that wait (module header): a record of their own in their conversation's
 * `cairn.approvals`, a workflow's script call, or a call of one of `tools`. Reads each
 * conversation's documents once; boot calls it before the Harness resumes.
 */
export const toolWaits = async (
  harness: Harness,
  tasks: ReadonlyArray<CountedTask>,
  tools: ReadonlySet<string>,
  context: ChordContext
): Promise<ReadonlySet<number>> => {
  const recordsOf = perConversation(async (conversationId) => {
    const doc = await harness.snapshot(Approvals, conversationId, context);

    return new Set(Object.keys(doc?.items ?? {}));
  });

  const scriptsOf = perConversation(async (conversationId) => {
    const doc = await harness.snapshot(WorkflowsDoc, conversationId, context);

    return new Set(
      Object.values(doc?.items ?? {}).flatMap((row) =>
        row.codemodeTaskId === null ? [] : [row.codemodeTaskId]
      )
    );
  });

  const named = namedWaits(tasks, tools);

  const waits = async (task: CountedTask): Promise<boolean> => {
    const id = Number(task.id);

    if (named.has(id)) {
      return true;
    }

    const records = await recordsOf(task.conversationId);

    if (records.has(approvalIdOf(id))) {
      return true;
    }

    const scripts = await scriptsOf(task.conversationId);

    if (scripts.has(id)) {
      return true;
    }

    if (tools.size === 0) {
      return false;
    }

    const name = await callName(harness, task, context);

    return Option.exists(name, (found) => tools.has(found));
  };

  const calls = tasks.filter((task) => task.kind === TOOL_TASK);
  const waiting = await Promise.all(calls.map(waits));

  return new Set(
    calls.flatMap((task, index) =>
      waiting[index] === true ? [Number(task.id)] : []
    )
  );
};

/**
 * The tool calls kept: each one that waits (`waits`), and every tool call it is nested under, so a
 * script is not ended while a call it made waits.
 */
const keptToolCalls = (
  tasks: ReadonlyArray<CountedTask>,
  waits: ReadonlySet<number>
): ReadonlySet<number> => {
  const byId = new Map(tasks.map((task) => [Number(task.id), task]));
  const kept = new Set<number>();

  for (const wait of waits) {
    let current = Option.some(wait);

    while (Option.isSome(current) && !kept.has(current.value)) {
      kept.add(current.value);

      current = Option.flatMap(
        Option.fromUndefinedOr(byId.get(current.value)),
        (task) =>
          Option.filter(
            Option.map(Option.fromUndefinedOr(task.owner), Number),
            (owner) => byId.get(owner)?.kind === TOOL_TASK
          )
      );
    }
  }

  return kept;
};

/**
 * The live tasks boot ends: cut off `CRASH_LIMIT` times in a row, not yet marked, not of a kind in
 * `kinds`, and not a tool call that waits (`waits`, from `toolWaits`) or holds one that does
 * (module header). Pure, so the rule is tested without a brain.
 */
export const crashLooped = (
  tasks: ReadonlyArray<CountedTask>,
  kept: {
    readonly kinds: ReadonlySet<string>;
    readonly waits: ReadonlySet<number>;
  }
): ReadonlyArray<CountedTask> => {
  const keptCalls = keptToolCalls(tasks, kept.waits);

  return tasks.filter(
    (task) =>
      !task.abortRequested &&
      (task.restarts ?? 0) >= CRASH_LIMIT &&
      !kept.kinds.has(task.kind) &&
      !(task.kind === TOOL_TASK && keptCalls.has(Number(task.id)))
  );
};

/** What one run of the accounting found: tasks at or past the limit, and those it marked. */
export interface CrashCount {
  readonly cutOff: number;
  readonly ended: ReadonlyArray<CountedTask>;
}

/**
 * The accounting over one Harness before it resumes (module header): reads its live tasks, marks
 * every crash-looped one for abort, and says what it found. `abortTask` only marks a task; nothing
 * runs until the Harness resumes. A mark that fails is left for the next boot; `onFailed` hears it.
 */
export const endCrashLoopedIn = async (
  harness: Harness,
  kept: KeptWaits,
  context: ChordContext,
  onFailed: (task: CountedTask, error: string) => void = Function.constVoid
): Promise<CrashCount> => {
  const inspection = await harness.inspect(context);
  const records = inspection.tasks.map((task) => task.record);
  const waits = await toolWaits(harness, records, kept.tools, context);
  const looped = crashLooped(records, { kinds: kept.kinds, waits });
  const ended: Array<CountedTask> = [];

  for (const task of looped) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- marks, one at a time
      await harness.abortTask(task.id, context);
      ended.push(task);
    } catch (error) {
      onFailed(task, errorText(error));
    }
  }

  return {
    // Every live task at or past the limit, kept ones included: how far the crashes went.
    cutOff: records.filter((task) => (task.restarts ?? 0) >= CRASH_LIMIT)
      .length,
    ended,
  };
};

/**
 * Boot's crash accounting (module header) on the brain's Session, after the Harness opens and
 * before it resumes. Nothing without pi-durable (the scripted harness never crashes).
 */
export const endCrashLoopedTasks = (kept: KeptWaits) =>
  Effect.gen(function* () {
    const found = yield* Effect.serviceOption(Brain);

    if (Option.isNone(found)) {
      return;
    }

    const { harness } = yield* found.value.session;
    const failed: Array<{ task: CountedTask; error: string }> = [];

    const count = yield* durable(
      "crash-limit",
      async (context) =>
        await endCrashLoopedIn(harness, kept, context, (task, error) => {
          failed.push({ task, error });
        })
    );

    for (const { task, error } of failed) {
      yield* Effect.logWarning("crash-looped task was not ended").pipe(
        Effect.annotateLogs({
          event: "boot_crash_limit_failed",
          taskId: task.id,
          error,
        })
      );
    }

    for (const task of count.ended) {
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

    yield* Effect.logInfo(
      `ended ${count.ended.length} crash-looped tasks`
    ).pipe(
      Effect.annotateLogs({
        event: "boot_crash_limit_done",
        ended: count.ended.length,
        cutOff: count.cutOff,
      })
    );
  });
