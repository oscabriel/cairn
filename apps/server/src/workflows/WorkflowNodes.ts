// The parts of the workflow node tools that close over nothing (WorkflowTools.ts builds the
// extension from them): who is calling a node tool, how a node asks its child and reads the answer,
// how a node's row settles, and how its watcher records a node or a script call that ended without
// settling. Each runs inside one tool or task invocation and commits only through that
// invocation's own `commit`.

import { EntryId as ProtocolEntryId } from "@cairn/protocol/Ids";
import type { RoleOverrides } from "@cairn/protocol/Roles";
import { RoleOverrides as RoleOverridesSchema } from "@cairn/protocol/Roles";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  EntryId,
  SubmissionId,
  TaskId,
  TaskOutcome,
  TaskRuntime,
  ToolExecutionApi,
  ToolExecutionResult,
  Tx,
} from "@earendil-works/pi-durable";
import { ToolResultEntry, UsageDoc } from "@earendil-works/pi-durable";
import { Option, Predicate, Result, Schema } from "effect";

import type { ApprovalRecord, JsonRecord } from "../brain/CairnDocs.ts";
import { messageText } from "../brain/CommitFeed.ts";
import { emit } from "../brain/Events.ts";
import { piEntryId } from "../brain/PiIds.ts";
import {
  NUDGE_TEXT,
  nudgeDue,
  readAttemptState,
  readResult,
} from "../models/ResultTool.ts";
import { conversationOf } from "../subagents/Delivery.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import { isObjectRootSchema } from "./Prelude.ts";
import type { NodeOutcome } from "./Prelude.ts";
import {
  isNodeEnded,
  isWorkflowEnded,
  launchOf,
  nudgeRequestIdOf,
  resultRefOf,
  settledTokens,
  usageTotals,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type {
  NodeItemState,
  NodeReceiptState,
  UsageTotals,
  WorkflowItemState,
} from "./WorkflowDocs.ts";
import { GATE_MEMO } from "./WorkflowGate.ts";

/** The largest result a row keeps inline, written out; a larger one keeps a reference to its child. */
export const ROW_RESULT_LIMIT_BYTES = 16_384;

/** The longest one-line summary a row keeps. */
const SUMMARY_LIMIT = 200;

/** The protocol's `DisplayText` limit: the longest error or label a row may hold and still decode. */
export const DISPLAY_TEXT_LIMIT = 4096;

/** Entries of a child a settle reads to count its tool calls. */
const TOOL_SCAN_LIMIT = 1000;

const decodeMark = Schema.decodeUnknownOption(
  Schema.Struct({ workflowId: Schema.String, scriptHash: Schema.String })
);

const decodeOverrides = Schema.decodeUnknownOption(RoleOverridesSchema);

const decodeToolTaskResult = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.String, entryId: Schema.Int })
);

/** An entry id from its stored number. */
export const entryOf = (id: number) => piEntryId(ProtocolEntryId.make(id));

/** A refused call: the script's `await` rejects with `text`. */
export const refused = (text: string): ToolExecutionResult => ({
  output: [{ type: "text", text }],
  isError: true,
});

/** The words a node's outcome shows the model in the script's details. */
const outcomeText = (outcome: NodeOutcome): string => {
  const node = outcome.nodeId ?? "";

  return outcome.status === "ok"
    ? `Node ${node} answered.`
    : `Node ${node} ${outcome.status}: ${outcome.reason ?? ""}`;
};

/** A node's answer to the script: its outcome, never its usage. */
export const outcomeResult = (outcome: NodeOutcome): ToolExecutionResult => ({
  output: [{ type: "text", text: outcomeText(outcome) }],
  structuredOutput: {
    status: outcome.status,
    value: copyJson(outcome.value),
    reason: outcome.reason,
    nodeId: outcome.nodeId,
  },
});

/** The first line of `text`, cut to the summary's length. */
export const summaryOf = (text: string): string => {
  const [line = ""] = text.trim().split("\n");

  return line.length > SUMMARY_LIMIT
    ? `${line.slice(0, SUMMARY_LIMIT - 1)}…`
    : line;
};

/** `text` cut to `limit` characters, marked when cut. */
export const cutText = (text: string, limit = DISPLAY_TEXT_LIMIT): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** What a row keeps of a result: the value, or a reference to its child when it is large. */
const rowResultOf = (value: JsonValue, conversationId: number): JsonValue => {
  const written = JSON.stringify(value);

  return Buffer.byteLength(written, "utf-8") <= ROW_RESULT_LIMIT_BYTES
    ? copyJson(value)
    : {
        ref: `conversation-${String(conversationId)}`,
        bytes: Buffer.byteLength(written, "utf-8"),
      };
};

/** A node's result schema, which must be a JSON Schema with an object root. */
export const nodeSchemaOf = (
  schema: Option.Option<Schema.Json>
): Result.Result<Option.Option<JsonRecord>, string> => {
  if (Option.isNone(schema)) {
    return Result.succeed(Option.none());
  }

  const record = jsonRecordOf(schema.value);

  return record !== null && isObjectRootSchema(schema.value)
    ? Result.succeed(Option.some(record))
    : Result.fail(
        "agent(): `schema` must be a JSON Schema whose root is an object"
      );
};

// The caller.

/** The workflow a nested call belongs to, read from its calling task's gate mark. */
export interface Caller {
  readonly workflowId: string;
  readonly scriptHash: string;
  readonly codemodeTaskId: TaskId;
}

/**
 * The caller of a node tool: the `codemode` task that owns this nested call, and the workflow the
 * gate marked it with. A model's own script carries no mark, so it gets the refusal's text.
 */
export const callerOf = async (
  api: Pick<ToolExecutionApi, "getTask" | "taskId">,
  context: ChordContext
): Promise<Result.Result<Caller, string>> => {
  const self = await api.getTask(api.taskId, context);
  const owner = self?.owner;

  if (owner === undefined) {
    return Result.fail(
      "Workflow node tools run only inside an approved workflow script."
    );
  }

  const script = await api.getTask(owner, context);

  const mark =
    script === undefined || script.memos === undefined
      ? Option.none()
      : decodeMark(script.memos[GATE_MEMO]);

  return Option.match(mark, {
    onNone: () =>
      Result.fail(
        "This script was not launched as a workflow: node tools run only inside a workflow script whose launch was approved, rewritten by the workflow gate."
      ),
    onSome: (found) =>
      Result.succeed({
        workflowId: found.workflowId,
        scriptHash: found.scriptHash,
        codemodeTaskId: owner,
      }),
  });
};

/** Why `row` does not take nodes from `caller` now; none when it does. */
export const runningProblem = (
  row: Readonly<WorkflowItemState> | undefined,
  caller: Caller
): Option.Option<string> => {
  if (row === undefined) {
    return Option.some(
      `Workflow ${caller.workflowId} is not in this thread's ledger.`
    );
  }

  if (row.state !== "running" || row.codemodeTaskId !== caller.codemodeTaskId) {
    return Option.some(
      `Workflow ${caller.workflowId} is ${row.state}, not running from this script call.`
    );
  }

  return Option.none();
};

/** Checks the caller of `tool` and that its workflow is running from it; the caller or the refusal. */
export const runningCaller = async (
  api: ToolExecutionApi,
  workflowId: string,
  tool: string,
  context: ChordContext
): Promise<Result.Result<Caller, string>> => {
  const caller = await callerOf(api, context);

  if (Result.isFailure(caller)) {
    return Result.fail(`${tool} refused: ${caller.failure}`);
  }

  if (caller.success.workflowId !== workflowId) {
    return Result.fail(
      `${tool} refused: this script runs workflow ${caller.success.workflowId}, not ${workflowId}.`
    );
  }

  const ledger = await api.snapshot(WorkflowsDoc, api.conversationId, context);
  const problem = runningProblem(ledger?.items[workflowId], caller.success);

  return Option.match(problem, {
    onSome: (text) => Result.fail(`${tool} refused: ${text}`),
    onNone: () => Result.succeed(caller.success),
  });
};

/** The role overrides a launch runs with: the user's edits on Go, else the model's proposal. */
export const overridesOf = (
  record: ApprovalRecord
): Option.Option<RoleOverrides> => {
  const edited = record.answer?.launch?.roleOverrides;

  if (edited !== undefined) {
    return decodeOverrides(edited);
  }

  return Option.map(launchOf(record), (launch) => launch.roleOverrides);
};

// Asking a child and reading its answer.

/** Text of an answer entry's assistant message. */
const answerTextOf = (model: ReadonlyArray<Message> | undefined): string => {
  const [message] = model ?? [];

  return message === undefined ? "" : messageText(message);
};

/** A child's answer to one input: the answer entry and the submission that got it. */
export interface Answered {
  readonly answer: EntryId;
  readonly submission: SubmissionId;
}

/**
 * Submits `content` to the child under `requestId` (first submission wins) and waits for it.
 * `submitted` runs between the two (a judge's hold point; production passes nothing).
 */
export const askChild = async (
  api: ToolExecutionApi,
  child: ConversationId,
  content: string,
  requestId: string,
  context: ChordContext,
  submitted: (submission: SubmissionId) => Promise<void> = async () => {
    await Promise.resolve();
  }
): Promise<Result.Result<Answered, string>> => {
  const handle = await api.conversation(child, context);

  if (handle === undefined) {
    return Result.fail(`its child conversation ${String(child)} is gone`);
  }

  const submission = await handle.submit(
    { type: "input", content, requestId },
    context
  );

  await submitted(submission.id);

  const settled = await submission.wait(context);

  if (settled.status === "done" && settled.answer !== undefined) {
    return Result.succeed({
      answer: settled.answer,
      submission: submission.id,
    });
  }

  return Result.fail(
    `its child's run ended unanswered (${settled.reason ?? settled.status})`
  );
};

/** The final text of a child's answer entry. */
export const answerText = async (
  api: Pick<ToolExecutionApi, "commit">,
  answer: EntryId,
  context: ChordContext
): Promise<string> => {
  const entry = await api.commit(async (tx) => await tx.entry(answer), context);

  return answerTextOf(entry?.model);
};

/** A typed child's accepted value and how many attempts it took. */
export interface TypedValue {
  readonly value: JsonValue;
  readonly attempts: number;
}

/**
 * The child's typed result, nudging it once when it ended without one (2E's rule). A rerun that
 * finds the nudge already sent (a `kill -9` while the child answered it) asks again under the
 * nudge's request id, which pi-durable answers with the first submission, so it waits for that
 * answer instead of failing a child that is still working.
 */
export const typedResult = async (
  api: ToolExecutionApi,
  requestId: string,
  child: ConversationId,
  context: ChordContext,
  nudgeSubmitted?: (submission: SubmissionId) => Promise<void>
): Promise<Result.Result<TypedValue, string>> => {
  const first = await readResult(api, child, context);

  if (Option.isSome(first)) {
    return Result.succeed({
      value: first.value.result,
      attempts: first.value.attempts,
    });
  }

  const attempts = await api.commit(
    async (tx) => await readAttemptState(tx, child),
    context
  );

  const asking = nudgeDue(attempts) || (attempts.nudged && !attempts.accepted);

  if (!asking) {
    return Result.fail(
      "invalid_result: its child ended without a valid submit_result"
    );
  }

  const nudged = await askChild(
    api,
    child,
    NUDGE_TEXT,
    nudgeRequestIdOf(requestId),
    context,
    nudgeSubmitted
  );

  if (Result.isFailure(nudged)) {
    return Result.fail(nudged.failure);
  }

  const second = await readResult(api, child, context);

  return Option.match(second, {
    onNone: () =>
      Result.fail(
        "invalid_result: its child ended without a valid submit_result after the nudge"
      ),
    onSome: (found) =>
      Result.succeed({ value: found.result, attempts: found.attempts }),
  });
};

/** The outcome an ended row answers on a rerun, its value read again from its child. */
export const endedOutcome = async (
  api: ToolExecutionApi,
  row: NodeItemState,
  context: ChordContext
): Promise<NodeOutcome> => {
  if (row.state === "refused") {
    return {
      status: "refused",
      value: null,
      reason: row.error ?? row.refusal,
      nodeId: row.id,
    };
  }

  if (row.state !== "settled" || row.conversationId === null) {
    return {
      status: row.state === "stopped" ? "stopped" : "failed",
      value: null,
      reason: row.error,
      nodeId: row.id,
    };
  }

  const typed = await readResult(
    api,
    conversationOf(row.conversationId),
    context
  );

  if (Option.isSome(typed)) {
    return {
      status: "ok",
      value: copyJson(typed.value.result),
      reason: null,
      nodeId: row.id,
    };
  }

  const answer = row.receipt?.answerEntry ?? null;

  const value =
    answer === null ? "" : await answerText(api, entryOf(answer), context);

  return { status: "ok", value, reason: null, nodeId: row.id };
};

// Settling.

/** How a node's child ended: its value, or why it failed. */
export type NodeEnding = Result.Result<
  {
    readonly value: JsonValue;
    readonly answer: EntryId;
    readonly schemaAttempts: number;
    readonly submission: SubmissionId;
  },
  string
>;

/** The stage a settled node reached: verified, validated against a schema, or answered. */
const stageOf = (
  value: JsonValue,
  schemaAttempts: number,
  verify: boolean
): NodeItemState["stage"] => {
  if (!verify) {
    return schemaAttempts > 0 ? "validated" : "answered";
  }

  const verdict =
    Predicate.isObject(value) && !Array.isArray(value)
      ? value.verdict
      : undefined;

  return verdict === "verified" ? "verified" : "answered";
};

/** Writes the ending into a running row. */
const applyEnding = (
  node: NodeItemState,
  ending: NodeEnding,
  child: ConversationId,
  verify: boolean
) => {
  if (Result.isFailure(ending)) {
    node.state = "failed";
    node.error = cutText(ending.failure);

    return;
  }

  const ended = ending.success;

  node.state = "settled";
  node.result = rowResultOf(ended.value, child);
  node.resultSummary = summaryOf(
    Predicate.isString(ended.value) ? ended.value : JSON.stringify(ended.value)
  );
  node.schemaAttempts = ended.schemaAttempts;
  node.submissionId = ended.submission;
  node.stage = stageOf(ended.value, ended.schemaAttempts, verify);
};

/** What a settle writes: whose node, its child and how it ended. */
export interface Settling {
  readonly caller: Caller;
  readonly nodeId: string;
  readonly child: ConversationId;
  readonly ending: NodeEnding;
  readonly verify: boolean;
}

/** A receipt from a child's usage totals and what the settle counted. */
const receiptOf = (
  totals: UsageTotals,
  counted: Pick<NodeReceiptState, "answerEntry" | "toolCalls" | "durationMs">
): NodeReceiptState => ({
  answerEntry: counted.answerEntry,
  input: totals.input,
  output: totals.output,
  cacheRead: totals.cacheRead,
  cacheWrite: totals.cacheWrite,
  totalTokens: totals.totalTokens,
  listMicros:
    totals.costTotal > 0 ? Math.round(totals.costTotal * 1_000_000) : null,
  toolCalls: counted.toolCalls,
  durationMs: counted.durationMs,
});

/** Tool calls among a child's latest entries (up to `TOOL_SCAN_LIMIT`); a table read. */
const toolCallsOf = async (tx: Tx, child: ConversationId): Promise<number> => {
  const entries = await tx.scanEntries(
    { conversationId: child, order: "descending" },
    TOOL_SCAN_LIMIT
  );

  return entries.items.filter((entry) => ToolResultEntry.is(entry)).length;
};

/**
 * Settles the row in one commit: receipt, result, state and the `workflow.node.settled` event,
 * written only by the row's own task and only while it runs. Failing settles `failed` the same way.
 */
export const settleNode = async (
  api: ToolExecutionApi,
  settling: Settling,
  context: ChordContext
): Promise<void> => {
  const { caller, nodeId, child, ending, verify } = settling;

  await api.commit(async (tx) => {
    // Table reads first: pi-durable refuses a table read after a table write.
    const toolCalls = await toolCallsOf(tx, child);

    const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
    const workflow = ledger.items[caller.workflowId];
    const node = workflow?.nodes[nodeId];

    if (
      workflow === undefined ||
      node === undefined ||
      node.nestedTaskId !== api.taskId ||
      isNodeEnded(node.state)
    ) {
      return;
    }

    const totals = usageTotals(await tx.doc(UsageDoc, child));
    const at = api.now();

    const receipt = receiptOf(totals, {
      answerEntry: Result.isSuccess(ending) ? ending.success.answer : null,
      toolCalls,
      durationMs: Math.max(0, at - (node.startedAt ?? at)),
    });

    node.receipt = receipt;
    node.endedAt = at;
    applyEnding(node, ending, child, verify);
    workflow.spent.tokens = settledTokens(workflow);

    await emit(tx, {
      name: "workflow.node.settled",
      data: {
        workflowId: workflow.id,
        nodeId: node.id,
        state: node.state,
        totalTokens: receipt.totalTokens,
      },
      at,
      context: Option.none(),
    });
  }, context);
};

// The watcher's records.

/**
 * A node's row after its task ended without settling it: stopped, or failed. Its receipt records
 * what its child used up to then, so a stopped node's spend still counts against the workflow's
 * budget (W6). Call it before any table write in the commit: it scans the child's entries.
 */
export const endNode = async (
  tx: Tx,
  row: WorkflowItemState,
  nodeId: string,
  outcome: TaskOutcome<unknown>,
  at: number
): Promise<void> => {
  const node = row.nodes[nodeId];

  if (node === undefined || isNodeEnded(node.state)) {
    return;
  }

  const stopped = outcome.status === "aborted";

  if (node.conversationId !== null && node.receipt === null) {
    const child = conversationOf(node.conversationId);
    const toolCalls = await toolCallsOf(tx, child);

    node.receipt = receiptOf(usageTotals(await tx.doc(UsageDoc, child)), {
      answerEntry: null,
      toolCalls,
      durationMs: Math.max(0, at - (node.startedAt ?? at)),
    });
  }

  node.state = stopped ? "stopped" : "failed";
  node.endedAt = at;
  row.spent.tokens = settledTokens(row);

  node.error = stopped
    ? "stopped before it answered"
    : cutText(
        outcome.error?.message ??
          `its task ended ${outcome.status} without settling`
      );

  await emit(tx, {
    name: stopped ? "workflow.node.stopped" : "workflow.node.settled",
    data: { workflowId: row.id, nodeId, state: node.state },
    at,
    context: Option.none(),
  });
};

/** How a workflow's script call ended, read from its task and its result entry. */
export interface ScriptEnding {
  readonly status: TaskOutcome<unknown>["status"];
  readonly isError: boolean;
  /** The result's text, where a replay's divergence is named. */
  readonly text: string;
}

/** How a script call ended: its task's outcome, and whether its result entry is an error. */
export const scriptEnding = async (
  runtime: Pick<TaskRuntime<never, never, never, object>, "entry">,
  outcome: TaskOutcome<unknown>,
  context: ChordContext
): Promise<ScriptEnding> => {
  if (outcome.status !== "completed") {
    return { status: outcome.status, isError: true, text: "" };
  }

  // A tool task's result names the entry its result went to.
  const reference = decodeToolTaskResult(outcome.result);

  if (Option.isNone(reference)) {
    return { status: outcome.status, isError: false, text: "" };
  }

  const entry = await runtime.entry(entryOf(reference.value.entryId), context);

  const [message] = entry?.model ?? [];

  if (message?.role !== "toolResult") {
    return { status: outcome.status, isError: false, text: "" };
  }

  return {
    status: outcome.status,
    isError: message.isError,
    text: message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  };
};

/** The words pi-durable's code mode ends a script with when its replay cannot go on. */
const REPLAY_ENDINGS = [
  "The script cannot resume:",
  "The script took a different path when resumed after a restart",
] as const;

/** Whether a script call's error text is code mode's replay ending, not the script's own error. */
export const isReplayEnding = (text: string): boolean =>
  REPLAY_ENDINGS.some((prefix) => text.includes(prefix));

/** The row's state and outcome for how its script call ended. */
const endingState = (
  ending: ScriptEnding
): Pick<WorkflowItemState, "state" | "outcome"> => {
  if (ending.status === "aborted") {
    return {
      state: "stopped",
      outcome: { kind: "partial", reason: "stopped" },
    };
  }

  if (!ending.isError) {
    return { state: "finished", outcome: { kind: "complete" } };
  }

  return {
    state: "failed",
    outcome: {
      kind: "partial",
      reason: isReplayEnding(ending.text) ? "replay_diverged" : "script_error",
    },
  };
};

/** A workflow's row after its script call ended: finished, failed or stopped. */
export const endWorkflow = async (
  tx: Tx,
  row: WorkflowItemState,
  ending: ScriptEnding,
  at: number
): Promise<void> => {
  if (isWorkflowEnded(row.state)) {
    return;
  }

  const ended = endingState(ending);

  row.state = ended.state;
  row.outcome = ended.outcome;
  row.endedAt = at;

  row.result =
    row.codemodeTaskId === null ? null : resultRefOf(row.codemodeTaskId);

  await emit(tx, {
    name: "workflow.finished",
    data: {
      workflowId: row.id,
      state: row.state,
      outcome: ended.outcome === null ? null : { ...ended.outcome },
    },
    at,
    context: Option.none(),
  });
};

/** Tokens a workflow spent so far: its settled receipts and its running children's usage. */
export const spentTokens = async (
  api: Pick<ToolExecutionApi, "snapshot">,
  row: Readonly<WorkflowItemState>,
  context: ChordContext
): Promise<number> => {
  const running = Object.values(row.nodes).flatMap((node) =>
    node.state === "running" && node.conversationId !== null
      ? [node.conversationId]
      : []
  );

  const live = await Promise.all(
    running.map(async (child) => {
      const usage = await api.snapshot(
        UsageDoc,
        conversationOf(child),
        context
      );

      return usageTotals(usage).totalTokens;
    })
  );

  return live.reduce((sum, tokens) => sum + tokens, settledTokens(row));
};
