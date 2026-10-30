// The workflow node tools (ADR 0012 as amended, ADR 0032, workflows note W3): the nested tools the
// prelude calls (`workflow_begin`, `agent`, `verify`, `approve`, `phase`, `log`, `budget`, all
// `callers: ["tools"]` and replay-safe), the watcher task that records how a node or a script call
// ended, and the gate hook, as one extension (`cairn.workflows`).
//
// Every node tool first checks its caller: a nested call of a `codemode` task the gate marked
// (`GATE_MEMO`) for a workflow that is `running` with that task as its script call. So a script
// the model wrote itself, or a forged `workflow_begin`, is refused even where the gate hook was left
// out of a selection. `workflow_begin` moves the approved row to `running` once, checking the
// launch approval is accepted and the hash and prelude version match, and creates the script
// call's watcher.
//
// `workflow_plan` (the model's tool, 5A) proposes a launch: it parses and dry-runs the script, writes
// a `proposed` row and the launch approval (a `brief` record whose payload is the plan and its
// envelope) in one commit, and waits for the answer like any gated call (ADR 0013). The answering
// commit moves the row (`launchAnswered`, WorkflowLaunch.ts); the tool then tells the model to run
// the same script with `codemode`, or that nothing will run.
//
// `agent` is one dispatch. In one commit it reserves the row (`n-<task id>`, request id
// `wf-<workflowId>-<nodeId>`) and writes the node's own brief record. When the launch's envelope
// covers it (role, reads or writes, mode, node cap: `briefWithin`) the record is accepted with
// `decidedBy` envelope and the same commit creates the child conversation owned by the node's own
// task, configured with the role's model, with the `cairn.child` link the result tool and the
// permission gate read, and the row's watcher. When it does not, the record is a pending brief card
// and the node waits for the user like any approval: Go creates the child in the commit after the
// answer, anything else ends the row `refused` and the script sees `null`. A rerun after `kill -9`
// finds the row (and the child, or the pending brief), submits under the same request id (which
// pi-durable answers with the first submission) and waits again: no second dispatch. A typed node's child ends with `submit_result`; one nudge, then
// it fails `invalid_result`. The settle is one commit (WorkflowNodes.ts), written only by the row's
// own task, and the tool's result never carries usage (spec section 12, "double-counted subagent
// spend"). At most the envelope's `maxConcurrent` nodes of one workflow run at once, held in
// memory, so a restart starts with every slot free.
//
// `agent(prompt, { resume: nodeId })` sends a settled node a further input (council pass 2) as a new
// node: its child is a fork of the old node's child at its latest entry, created in the same reserve
// commit and owned by the new node's task, so the new child continues with the whole earlier
// context while the new row keeps its own receipt (a fork's `pi.usage` starts at zero), result and
// stop. It runs as the role its own call names, or the default role, never the old node's: the
// plan's dry run records the call site that way and the envelope grants just that. A node that is
// not settled, or whose conversation is gone, cannot be resumed: the script sees `null` and the
// council falls back to a fresh node.
//
// A node stopped, or a script call that ends, is recorded by the watcher (`cairn.workflow-watch`), a
// background task created in the commit that started the work: an aborted tool cannot commit, and
// a watcher survives `kill -9` as any task does.
//
// Ported in intent from spike 3's `brain.ts` (the `agent` and `approve` nodes) and the workflows
// probe's node-stop brain.

import { setTimeout as sleep } from "node:timers/promises";

import { ThinkingLevel } from "@cairn/protocol/Models";
import type {
  ApprovalDecision,
  Envelope,
  RuntimeMode,
} from "@cairn/protocol/Policy";
import type { RoleOverrides } from "@cairn/protocol/Roles";
import { RoleSpec } from "@cairn/protocol/Roles";
import { Budget, DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { MAX_SUBAGENT_DEPTH } from "@cairn/protocol/Subagents";
import { MAX_WORKFLOW_NODES } from "@cairn/protocol/Workflows";
import type { NodeRefusal } from "@cairn/protocol/Workflows";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  AgentChange,
  ConversationId,
  EntryId,
  NextTaskState,
  SubmissionId,
  ToolExecutionApi,
  ToolExecutionResult,
  Tx,
} from "@earendil-works/pi-durable";
import {
  configure,
  defineExtension,
  defineTask,
  defineTool,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { DateTime, Effect, Option, Predicate, Result, Schema } from "effect";

import {
  approvalIdOf,
  approvalLedger,
  Approvals,
  emitBriefApproved,
  ThreadMeta,
  ThreadReceipt,
  writeMode,
} from "../brain/CairnDocs.ts";
import type {
  ApprovalRecord,
  ApprovalRequest,
  JsonRecord,
} from "../brain/CairnDocs.ts";
import { ScriptSlots } from "../brain/CodeMode.ts";
import { emit } from "../brain/Events.ts";
import { ExtensionOrder } from "../brain/Extensions.ts";
import type { CairnExtension } from "../brain/Extensions.ts";
import {
  cutSummary,
  GATED_APPROVAL_TTL_MILLIS,
  readPermissions,
} from "../brain/Permissions.ts";
import { usageLimitOf } from "../brain/RunFailure.ts";
import {
  childThreadIdOf,
  conversationOf,
  taskOf,
} from "../subagents/Delivery.ts";
import { ChildDoc, isLinked } from "../subagents/SubagentDocs.ts";
import { nodeChildTools } from "../subagents/Subagents.ts";
import {
  AgentCall,
  ApproveCall,
  BeginCall,
  BudgetCall,
  DEFAULT_NODE_ROLE,
  DEFAULT_VERIFY_ROLE,
  LogCall,
  PhaseCall,
  PRELUDE_VERSION,
  VerifyCall,
} from "./Prelude.ts";
import type { NodeOutcome } from "./Prelude.ts";
import {
  applyMeter,
  budgetPushTask,
  BudgetStopper,
  budgetStopped,
  effectiveBudget,
  MAX_HOLDS,
  METER_INTERVAL_MILLIS,
  meterCommit,
  minutesLineOf,
  NO_BUDGET_PUSH,
  readSpends,
  SpendCache,
} from "./WorkflowBudget.ts";
import type { BudgetPushSink } from "./WorkflowBudget.ts";
import {
  dispatchedCount,
  envelopeOf,
  isNodeEnded,
  nextIndex,
  nodeIdOf,
  nodeRequestIdOf,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type { NodeItemState, WorkflowItemState } from "./WorkflowDocs.ts";
import { workflowGate } from "./WorkflowGate.ts";
import {
  briefWithin,
  closeWaiting,
  isWaitingNode,
  nodeBriefPayload,
  nodeBriefRecord,
} from "./WorkflowLaunch.ts";
import type { Outside } from "./WorkflowLaunch.ts";
import {
  answerText,
  askChildFully,
  BUDGET_STOP_TEXT,
  callerOf,
  cutText,
  endedOutcome,
  endNode,
  endWorkflow,
  nodeSchemaOf,
  outcomeResult,
  overridesOf,
  refused,
  runningCaller,
  runningProblem,
  scriptEnding,
  settleNode,
  spentTokens,
  summaryOf,
  typedResult,
} from "./WorkflowNodes.ts";
import type { Caller, NodeEnding } from "./WorkflowNodes.ts";
import { planTool } from "./WorkflowPlanTool.ts";
import type { PlanAccess } from "./WorkflowPlanTool.ts";
import { throwIfStopped, untilStopped } from "./WorkflowStop.ts";

/** The extension's name in pi-durable's registry. */
export const WORKFLOWS_EXTENSION = "cairn.workflows";

/** The watcher task's name. */
export const WATCH_TASK = "cairn.workflow-watch";

/** The longest `log()` line a row keeps. */
export const LOG_LINE_LIMIT = 2000;

/** The longest phase title the protocol carries. */
const PHASE_TITLE_LIMIT = 120;

/** The longest `key` a row keeps. */
const KEY_LIMIT = 200;

/** The most options a question may offer (the protocol's `Question`). */
const MAX_APPROVE_OPTIONS = 9;

const isRoleSpec = Schema.is(RoleSpec);

const isThinkingLevel = Schema.is(ThinkingLevel);

/** A script's optional text, trimmed and cut to `limit`; none when nothing is left. */
const optionalText = (
  text: Option.Option<string>,
  limit: number
): Option.Option<string> =>
  Option.filter(
    Option.map(text, (given) => given.trim().slice(0, limit).trim()),
    (kept) => kept !== ""
  );

/** A node's label: the script's first line, cut, else the prompt's. */
const labelOf = (label: Option.Option<string>, prompt: string): string =>
  Option.getOrElse(
    Option.filter(Option.map(label, summaryOf), (kept) => kept !== ""),
    () => summaryOf(prompt)
  );

/** The verdict a `verify` node answers, as its child's `submit_result` schema. */
export const VERDICT_SCHEMA: JsonRecord = {
  type: "object",
  title: "verdict",
  properties: {
    verdict: { type: "string", enum: ["verified", "refuted", "unverified"] },
    reason: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
};

/** What a role spec resolved to at dispatch (ADR 0035), as the node's row records it. */
export interface ResolvedNodeModel {
  readonly provider: string;
  readonly modelId: string;
  readonly thinkingLevel: Option.Option<ThinkingLevel>;
}

/**
 * Resolves a role spec with the launch's overrides right before the commit that creates the child
 * (2D's dispatch rule). Fails with the words the script's `agent.full` shows.
 */
export type RoleResolver = (
  spec: string,
  overrides: Option.Option<RoleOverrides>
) => Promise<Result.Result<ResolvedNodeModel, string>>;

/** Where a judge may hold a node, so its `kill -9` lands there. */
export type HoldPoint =
  | "after-reserve"
  | "after-submit"
  | "after-nudge"
  | "before-settle";

/** The broken controls the kill judge runs; production plants none. */
export interface WorkflowFaultSet {
  /**
   * A dispatch that ignores its row: every attempt of a node makes a fresh child and submits under
   * a fresh request id, so a rerun after a kill dispatches again.
   */
  readonly freshDispatch: boolean;
  /**
   * An envelope that covers every node: a node the launch did not show starts without its own
   * brief card, as if the envelope granted it (the envelope judge's broken control).
   */
  readonly grantAll: boolean;
  /** An admission that never refuses at the budget's line: the budget judge's control. */
  readonly ignoreBudget: boolean;
  /**
   * Node tools deaf to a stop: their waits ignore the abort signal (no `untilStopped`), so a stop
   * of a node held in one waits the hold out.
   */
  readonly deafToStop: boolean;
}

/** No faults. */
export const NO_WORKFLOW_FAULTS: WorkflowFaultSet = {
  freshDispatch: false,
  grantAll: false,
  ignoreBudget: false,
  deafToStop: false,
};

/** What the extension is built with. */
export interface WorkflowToolOptions {
  readonly resolveRole: RoleResolver;
  /** Parses and dry-runs a proposed script (`WorkflowPlan`), for `workflow_plan`. */
  readonly plan: PlanAccess;
  readonly faults: WorkflowFaultSet;
  /** Waits at a hold point (judges only); production resolves at once. */
  readonly hold: (point: HoldPoint, label: string) => Promise<void>;
  /**
   * How long a node held by a usage limit that names no reset waits before it tries again:
   * `HOLD_RETRY_MILLIS` in production, shorter in tests.
   */
  readonly holdRetryMillis: number;
  /** Where the soft line's push goes (`WorkflowPushes`); none sends nothing. */
  readonly push?: BudgetPushSink;
}

/** A hold that never waits. */
export const NO_HOLD = async (): Promise<void> => {
  await Promise.resolve();
};

const decodeBegin = Schema.decodeUnknownOption(BeginCall);

const decodeAgent = Schema.decodeUnknownOption(AgentCall);

const decodeVerify = Schema.decodeUnknownOption(VerifyCall);

const decodeApprove = Schema.decodeUnknownOption(ApproveCall);

const decodePhase = Schema.decodeUnknownOption(PhaseCall);

const decodeLog = Schema.decodeUnknownOption(LogCall);

const decodeBudget = Schema.decodeUnknownOption(BudgetCall);

/** Any JSON object: the prelude builds every argument, and each tool decodes its own. */
const anyObject = Type.Unsafe<{ [key: string]: JsonValue }>({
  type: "object",
});

/** A conversation-owned background task: a thread's Stop and idle waits never reach it. */
const BACKGROUND = {
  ownership: { kind: "conversation" },
  background: true,
} as const;

/** A running node the meter may commit through: its invocation and its context. */
interface MeterNode {
  readonly api: ToolExecutionApi;
  readonly context: ChordContext;
}

/** One workflow's live meter, in memory: when it last wrote and the nodes running now. */
interface MeterState {
  last: number;
  scheduled: boolean;
  readonly nodes: Set<MeterNode>;
}

/** What a node's child is sent to go on after a usage limit's reset. */
export const CONTINUE_TEXT =
  "The provider's usage limit that stopped you has reset. Go on with your task from where you stopped.";

/** How often a held node looks whether its workflow reached its budget's line. */
const HOLD_POLL_MILLIS = 1000;

/** Whether workflow `workflowId` is at its budget's line now, from committed documents. */
const atLine = async (
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  workflowId: string,
  context: ChordContext
): Promise<boolean> => {
  const ledger = await api.snapshot(WorkflowsDoc, api.conversationId, context);
  const approvals = await api.snapshot(Approvals, api.conversationId, context);
  const row = ledger?.items[workflowId];

  return row !== undefined && budgetStopped(row, approvals?.items ?? {});
};

/**
 * Whether the child already took the node's input: a `kill -9` between the submit and the commit
 * that marks the row `submitted` leaves the row at `child_created` with the child working. Such a
 * node waits for its child (the stopper aborts it) instead of settling while the child goes on.
 */
const inputWentIn = async (
  api: Pick<ToolExecutionApi, "commit">,
  child: ConversationId,
  requestId: string,
  context: ChordContext
): Promise<boolean> =>
  await api.commit(
    async (tx) =>
      (await tx.submissionByRequest(child, requestId)) !== undefined,
    context
  );

/**
 * A settled node an `agent` call resumes (council pass 2): its id and its child conversation, which
 * the new node forks at its latest entry, so the new child carries the old one's whole context.
 */
interface ResumeTarget {
  readonly nodeId: string;
  readonly conversationId: ConversationId;
}

/** One node to dispatch, from an `agent` or a `verify` call. */
interface Dispatch {
  readonly workflowId: string;
  readonly prompt: string;
  readonly label: string;
  readonly phase: Option.Option<string>;
  readonly role: string;
  readonly schema: Option.Option<JsonRecord>;
  readonly key: Option.Option<string>;
  readonly readonly: boolean;
  readonly effort: Option.Option<string>;
  readonly verify: boolean;
  /** The node this one resumes; none starts a fresh child. */
  readonly resume: Option.Option<ResumeTarget>;
}

/** What the reserve commit found or made. */
type Reserved =
  | { readonly kind: "ended"; readonly row: NodeItemState }
  | {
      readonly kind: "running";
      readonly row: NodeItemState;
      readonly child: ConversationId;
    }
  /** Outside its envelope: its own brief waits for the user. */
  | { readonly kind: "waiting"; readonly row: NodeItemState }
  | { readonly kind: "problem"; readonly text: string };

/** What the reserve commit is given, read before it. */
interface ReserveInput {
  readonly nodeId: string;
  readonly caller: Caller;
  readonly dispatch: Dispatch;
  readonly model: Result.Result<ResolvedNodeModel, string>;
  /** The launching thread's effective mode: the child's. */
  readonly mode: RuntimeMode;
  /** The launching conversation's cwd, where the child works (shared checkout); none without one. */
  readonly cwd: Option.Option<string>;
  /** The launching thread's own `cairn.child` link, when it is itself a child. */
  readonly parentLink: Option.Option<{
    readonly depth: number;
    readonly rootThreadId: string;
  }>;
}

const decodeBudgetState = Schema.decodeUnknownOption(Budget);

/** The budget a workflow runs under, as the protocol reads it: the row's, edits included. */
const budgetOf = (row: WorkflowItemState): Budget =>
  Option.getOrElse(decodeBudgetState(row.budget), () => DEFAULT_BUDGET);

/** A row the reserve commit starts from, before its refusal or its child. */
const reservedRow = (
  api: ToolExecutionApi,
  row: WorkflowItemState,
  input: ReserveInput
): NodeItemState => {
  const { dispatch, nodeId } = input;

  return {
    id: nodeId,
    workflowId: row.id,
    key: Option.getOrNull(dispatch.key),
    label: dispatch.label,
    phase: Option.getOrNull(dispatch.phase),
    index: nextIndex(row),
    requestId: nodeRequestIdOf(row.id, nodeId),
    briefId: null,
    role: dispatch.role,
    provider: null,
    modelId: null,
    effort: Option.getOrNull(dispatch.effort),
    readonly: dispatch.readonly,
    arms: "host",
    state: "reserved",
    stage: "reserved",
    childThreadId: null,
    conversationId: null,
    submissionId: null,
    nestedTaskId: api.taskId,
    attempt: 1,
    schemaAttempts: 0,
    receipt: null,
    result: null,
    resultSummary: null,
    refusal: null,
    held: null,
    startedAt: api.now(),
    endedAt: null,
    error: null,
  };
};

/**
 * Why a node may not start at all, before its brief: no launch to read an envelope from, the
 * workflow's hard cap of nodes reached, or no model for its role. The envelope's own checks raise
 * a brief card instead (`briefWithin`).
 */
const refusalOf = (
  envelope: Option.Option<Envelope>,
  row: WorkflowItemState,
  input: ReserveInput
): Option.Option<NodeRefusal> => {
  if (Option.isNone(envelope)) {
    return Option.some("outside_grant");
  }

  if (dispatchedCount(row) >= MAX_WORKFLOW_NODES) {
    return Option.some("node_cap");
  }

  return Result.isFailure(input.model)
    ? Option.some("no_provider")
    : Option.none();
};

/** What a node asks of its envelope, from its dispatch and the thread now. */
const askOf = (row: WorkflowItemState, input: ReserveInput) => ({
  role: input.dispatch.role,
  readonly: input.dispatch.readonly,
  mode: input.mode,
  dispatched: dispatchedCount(row),
});

/**
 * The refusal a node outside its envelope ends with when its own brief is not accepted: past the
 * node cap when its role and mode fit, outside the grant otherwise.
 */
const declinedRefusal = (
  envelope: Envelope,
  row: WorkflowItemState,
  input: ReserveInput
): NodeRefusal =>
  Option.isNone(
    briefWithin(
      { ...envelope, maxNodes: MAX_WORKFLOW_NODES },
      { ...askOf(row, input), dispatched: 0 }
    )
  )
    ? "node_cap"
    : "outside_grant";

/** The prompt a node's child is sent. */
const promptOf = (dispatch: Dispatch) =>
  Option.isSome(dispatch.schema)
    ? `${dispatch.prompt}\n\nWhen you are done, call submit_result with your result; its parameters are the schema it must match.`
    : dispatch.prompt;

/** The brief record a node is dispatched under: accepted by `envelope`, or a pending card. */
const nodeRecordOf = (
  api: ToolExecutionApi,
  row: WorkflowItemState,
  input: ReserveInput,
  outside: Option.Option<Outside>
) => {
  const { dispatch } = input;

  return nodeBriefRecord({
    id: approvalIdOf(api.taskId),
    toolTaskId: api.taskId,
    tool: dispatch.verify ? "verify" : "agent",
    summary: cutSummary(`Run node "${dispatch.label}" of workflow ${row.name}`),
    at: api.now(),
    payload: nodeBriefPayload({
      workflowName: row.name,
      label: dispatch.label,
      prompt: promptOf(dispatch),
      role: dispatch.role,
      effort: dispatch.effort,
      readonly: dispatch.readonly,
      mode: input.mode,
      budget: budgetOf(row),
      resultSchema: dispatch.schema,
      outside,
    }),
    envelope: Option.isNone(outside)
      ? Option.some(row.approvalId)
      : Option.none(),
  });
};

/**
 * The agent change a node's child is created with: the role's model, the launching conversation's
 * cwd (so its file and shell tools have an environment, and the bridge a cwd), no subagent tools
 * (a node cannot spawn), and the result tool when typed (`nodeChildTools`).
 */
const childAgentOf = (
  resolved: ResolvedNodeModel,
  typed: boolean,
  cwd: Option.Option<string>
): AgentChange => ({
  model: { provider: resolved.provider, modelId: resolved.modelId },
  ...Option.match(cwd, {
    onNone: () => ({}),
    onSome: (dir) => ({ cwd: dir }),
  }),
  ...Option.match(resolved.thinkingLevel, {
    onNone: () => ({}),
    onSome: (level) => ({ thinkingLevel: level }),
  }),
  ...nodeChildTools(typed),
});

/**
 * Writes the child's thread identity (`cairn.thread` receipt and `cairn.thread-meta`, as 3A's
 * creating commit does, so spend, approvals and the shell can find it), its `cairn.child` link,
 * approvals and mode in the creating commit.
 */
const linkChild = async (
  tx: Tx,
  parent: ConversationId,
  child: ConversationId,
  link: {
    readonly nodeId: string;
    readonly approvalId: string;
    readonly childThreadId: string;
    readonly schema: Option.Option<JsonRecord>;
    readonly mode: RuntimeMode;
    readonly parentLink: ReserveInput["parentLink"];
  }
) => {
  const parentMeta = await tx.doc(ThreadMeta, parent);

  const receipt = await tx.doc(ThreadReceipt, link.childThreadId, {
    conversationId: 0,
  });

  receipt.conversationId = child;

  const meta = await tx.doc(ThreadMeta, child);

  meta.threadId = link.childThreadId;
  meta.projectId = parentMeta.projectId;

  const doc = await tx.doc(ChildDoc, child);

  doc.key = link.nodeId;
  doc.parentThreadId = parentMeta.threadId;
  doc.parentConversationId = parent;
  doc.rootThreadId = Option.match(link.parentLink, {
    onNone: () => parentMeta.threadId,
    onSome: (found) => found.rootThreadId,
  });
  doc.depth = Math.min(
    MAX_SUBAGENT_DEPTH,
    Option.match(link.parentLink, {
      onNone: () => 1,
      onSome: (found) => found.depth + 1,
    })
  );
  doc.briefApprovalId = link.approvalId;
  doc.resultSchema = Option.getOrNull(link.schema);
  doc.permissionMode = link.mode;

  await tx.doc(Approvals, child);
  await writeMode(tx, child, link.mode);
};

/** The refusal of a role that is no role spec: no row is written for it. */
const roleProblem = (tool: string, role: string) =>
  `${tool}(): role \`${summaryOf(role)}\` is not a role alias (\`@worker\`, \`@scout:high\`) or a \`provider/model\`.`;

/** The outcome the script gets for a node's ending. */
const outcomeOf = (ending: NodeEnding, nodeId: string): NodeOutcome =>
  Result.match(ending, {
    onFailure: (text): NodeOutcome => ({
      status: "failed",
      value: null,
      reason: text,
      nodeId,
    }),
    onSuccess: (ended): NodeOutcome => ({
      status: "ok",
      value: ended.value,
      reason: null,
      nodeId,
    }),
  });

/** The approval request `approve()` makes: a yes or no, or a question with the script's options. */
const approveRequest = (
  summary: string,
  choices: Option.Option<ReadonlyArray<string>>
): ApprovalRequest =>
  Option.match(choices, {
    onNone: (): ApprovalRequest => ({
      tool: "approve",
      kind: "tool-call",
      summary,
      ttlMillis: GATED_APPROVAL_TTL_MILLIS,
      payload: Option.none(),
      acceptedBy: Option.none(),
    }),
    onSome: (labels): ApprovalRequest => ({
      tool: "approve",
      kind: "user-input",
      summary,
      ttlMillis: GATED_APPROVAL_TTL_MILLIS,
      payload: Option.some({
        type: "questions",
        questions: [
          {
            header: "Workflow",
            question: summary,
            options: labels.map((label) => ({
              label,
              description: null,
              recommended: false,
            })),
            multiSelect: false,
            allowCustomAnswer: false,
          },
        ],
      }),
      acceptedBy: Option.none(),
    }),
  });

/** The text of a call to `verify`: the claim and the evidence, for a fresh child. */
const verifyPrompt = (claim: string, result: Schema.Json): string =>
  [
    "Check one claim against the evidence below, in a fresh context. Read what you need; change nothing.",
    `Claim: ${claim}`,
    "Evidence (another node's result):",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    "Answer verified when the evidence supports the claim, refuted when it contradicts it, unverified when you cannot tell, with your reason.",
  ].join("\n");

/** The words a script's `agent.full` shows for a `resume` it cannot take. */
const resumeProblem = (nodeId: string, why: string) =>
  `agent(): cannot resume node \`${summaryOf(nodeId)}\`: ${why}. Start a new node with what it needs instead.`;

/** The latest entry of `conversation`, where a resumed node's fork starts; none when it has none. */
const latestEntryOf = async (
  tx: Tx,
  conversation: ConversationId
): Promise<Option.Option<EntryId>> => {
  const page = await tx.scanEntries(
    { conversationId: conversation, order: "descending" },
    1
  );

  return Option.map(Option.fromUndefinedOr(page.items[0]), (entry) => entry.id);
};

/**
 * The node `resume` names, read from the ledger: a settled node of the same workflow with a child
 * conversation. None when the call resumes nothing; the refusal's words
 * when it names a node that cannot be resumed (unknown, still running, failed, stopped, refused).
 */
const resumeTargetOf = async (
  api: ToolExecutionApi,
  workflowId: string,
  resume: Option.Option<string>,
  context: ChordContext
): Promise<Result.Result<Option.Option<ResumeTarget>, string>> => {
  if (Option.isNone(resume)) {
    return Result.succeed(Option.none());
  }

  const nodeId = resume.value;
  const ledger = await api.snapshot(WorkflowsDoc, api.conversationId, context);
  const node = ledger?.items[workflowId]?.nodes[nodeId];

  if (node === undefined) {
    return Result.fail(
      resumeProblem(nodeId, "it is not a node of this workflow")
    );
  }

  if (node.state !== "settled" || node.conversationId === null) {
    return Result.fail(
      resumeProblem(
        nodeId,
        `it is ${node.state}, and only a settled node can be resumed`
      )
    );
  }

  return Result.succeed(
    Option.some({
      nodeId,
      conversationId: conversationOf(node.conversationId),
    })
  );
};

/** Writes a refused row and its event; a rerun reads the decision instead of making it again. */
const refuseRow = async (
  tx: Tx,
  row: WorkflowItemState,
  base: NodeItemState,
  refusal: NodeRefusal,
  error: string | null,
  at: number = base.startedAt ?? 0
): Promise<Reserved> => {
  const node: NodeItemState = {
    ...base,
    state: "refused",
    refusal,
    endedAt: at,
    error: error === null ? null : cutText(error),
  };

  row.nodes[node.id] = node;

  await emit(tx, {
    name: "workflow.node.refused",
    data: { workflowId: row.id, nodeId: node.id, refusal },
    at,
    context: Option.none(),
  });

  return { kind: "ended", row: { ...node } };
};

/** Records the row's submission once its input is in: stage `submitted`, its submission id. */
const markSubmitted = async (
  api: ToolExecutionApi,
  workflowId: string,
  nodeId: string,
  submission: SubmissionId,
  context: ChordContext
): Promise<void> => {
  await api.commit(async (tx) => {
    const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
    const node = ledger.items[workflowId]?.nodes[nodeId];

    if (
      node?.state === "running" &&
      node.nestedTaskId === api.taskId &&
      node.stage === "child_created"
    ) {
      node.stage = "submitted";
      node.submissionId = submission;
    }
  }, context);
};

/** What an earlier attempt left of a node: ended, running, or still waiting for its brief. */
const foundOf = (existing: NodeItemState): Reserved => {
  if (isWaitingNode(existing)) {
    return { kind: "waiting", row: { ...existing } };
  }

  return isNodeEnded(existing.state) || existing.conversationId === null
    ? { kind: "ended", row: { ...existing } }
    : {
        kind: "running",
        row: { ...existing },
        child: conversationOf(existing.conversationId),
      };
};

/** The launch approval of a workflow of this thread, read now. */
const launchRecordOf = async (
  api: ToolExecutionApi,
  workflowId: string,
  context: ChordContext
): Promise<Option.Option<ApprovalRecord>> => {
  const approvals = await api.snapshot(Approvals, api.conversationId, context);

  const ledger = await api.snapshot(WorkflowsDoc, api.conversationId, context);

  const approvalId = ledger?.items[workflowId]?.approvalId;

  return Option.fromUndefinedOr(
    approvalId === undefined ? undefined : approvals?.items[approvalId]
  );
};

/** The tools, the watcher task and the gate, as one extension. */
export const workflowExtension = (
  options: WorkflowToolOptions
): CairnExtension => {
  const { resolveRole, faults, plan, holdRetryMillis, push } = options;

  /** Each child's responses read so far, for the meter (WorkflowBudget.ts). */
  const cache = new SpendCache();

  /** A wait in a node tool, ended by a stop (WorkflowStop.ts) unless the judge's fault deafens it. */
  const stoppable = async <A>(
    context: ChordContext,
    work: Promise<A>
  ): Promise<A> =>
    faults.deafToStop
      ? await work
      : await untilStopped(context.abortSignal, work);

  /** A judge's hold point, which a stop ends. */
  const hold = async (
    point: HoldPoint,
    label: string,
    context: ChordContext
  ): Promise<void> => {
    await stoppable(context, options.hold(point, label));
  };

  /** Node slots per workflow, in memory: a restart starts with every slot free. */
  const slots = new Map<string, ScriptSlots>();

  /** Each workflow's live meter: its running nodes, and when it last wrote. */
  const meters = new Map<string, MeterState>();

  /** One meter commit through a running node's invocation; a node that ended meanwhile skips it. */
  const meterThrough = async (
    workflowId: string,
    node: MeterNode
  ): Promise<void> => {
    const { api, context } = node;

    await api
      .commit(
        async (tx) =>
          await meterCommit(
            tx,
            api.conversationId,
            workflowId,
            api.now(),
            api.models,
            cache
          ),
        context
      )
      .catch(() => Option.none());
  };

  /**
   * Asks for a meter commit of `workflowId` soon: at once when the last was a second ago or more,
   * else once at the end of that second, through whichever of its nodes still runs then.
   */
  const meterSoon = (workflowId: string, now: number) => {
    const state = meters.get(workflowId);

    if (state === undefined || state.scheduled) {
      return;
    }

    state.scheduled = true;

    setTimeout(
      () => {
        state.scheduled = false;

        // A node whose invocation ended (a stop between its wait and its meter's stop) refuses
        // even a clock read, so the meter goes through one still running.
        for (const node of state.nodes) {
          const read = Result.try(() => node.api.now());

          if (Result.isSuccess(read)) {
            state.last = read.success;
            void meterThrough(workflowId, node);

            return;
          }

          state.nodes.delete(node);
        }
      },
      Math.max(0, state.last + METER_INTERVAL_MILLIS - now)
    );
  };

  /**
   * Meters a running node's workflow while its child answers: on each change of the child's
   * `pi.usage`, and once at the minutes line. Answers the function that stops it.
   */
  const startMeter = async (
    api: ToolExecutionApi,
    workflowId: string,
    child: ConversationId,
    deadline: Option.Option<number>,
    context: ChordContext
  ): Promise<() => Promise<void>> => {
    const node: MeterNode = { api, context };

    const state = meters.get(workflowId) ?? {
      last: 0,
      scheduled: false,
      nodes: new Set<MeterNode>(),
    };

    meters.set(workflowId, state);
    state.nodes.add(node);

    // The invocation may end before the meter stops (a stop in a deaf wait); its clock then throws.
    const soon = () => {
      const now = Result.try(() => api.now());

      if (Result.isSuccess(now)) {
        meterSoon(workflowId, now.success);
      }
    };

    const watch = await api.watchDoc(UsageDoc, child, context);

    watch?.start(async () => {
      soon();
      await Promise.resolve();
    });

    const timer = Option.map(deadline, (at) =>
      setTimeout(
        () => {
          soon();
        },
        Math.max(0, at - api.now())
      )
    );

    return async () => {
      Option.map(timer, clearTimeout);
      state.nodes.delete(node);
      await watch?.stop();
    };
  };

  const slotsOf = (workflowId: string, limit: number): ScriptSlots => {
    const found = slots.get(workflowId);

    if (found !== undefined) {
      return found;
    }

    const made = new ScriptSlots(limit);

    slots.set(workflowId, made);

    return made;
  };

  /** Records how a node's task or a script call ended, once that task is terminal. */
  const Watch = defineTask<
    { workflowId: string; nodeId: string | null; target: number },
    { phase: "wait" },
    null
  >({
    name: WATCH_TASK,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: async (task, runtime, context) => {
        const { workflowId, nodeId, target } = task.input;
        const settled = await runtime.waitForTask(taskOf(target), context);
        const { outcome } = settled.state;
        const at = runtime.now();

        const ending =
          nodeId === null
            ? Option.some(await scriptEnding(runtime, outcome, context))
            : Option.none();

        await runtime.commit(
          async (tx): Promise<NextTaskState<{ phase: "wait" }, null>> => {
            const ledger = await tx.doc(WorkflowsDoc, runtime.conversationId);
            const approvals = await tx.doc(Approvals, runtime.conversationId);
            const row = ledger.items[workflowId];

            const node = nodeId === null ? undefined : row?.nodes[nodeId];

            // A node still waiting for its own brief: the brief goes with it.
            if (
              row !== undefined &&
              node !== undefined &&
              isWaitingNode(node)
            ) {
              await closeWaiting(tx, runtime.conversationId, row, node, at);
            } else if (row !== undefined && nodeId !== null) {
              // Table reads first: the ended node's receipt takes its spend, and the meter owns
              // `row.spent` (WorkflowBudget.ts).
              const spends = await readSpends(tx, row, runtime.models, cache);

              await endNode(tx, row, nodeId, outcome, at, spends);

              await applyMeter(tx, {
                conversationId: runtime.conversationId,
                row,
                approvals: approvals.items,
                spends,
                at,
              });
            }

            if (row !== undefined && Option.isSome(ending)) {
              await endWorkflow(tx, row, ending.value, at, approvals.items);
            }

            return {
              status: "terminal",
              outcome: { status: "completed", result: null },
            };
          },
          context
        );

        // The script call ended, so its workflow takes no more nodes: its slots and meter go.
        if (nodeId === null) {
          slots.delete(workflowId);
          meters.delete(workflowId);
        }
      },
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context
      );
    },
  });

  // workflow_begin

  /** Moves the approved row to running from `caller`; the refusal's words, or none. */
  const beginRow = async (
    api: ToolExecutionApi,
    caller: Caller,
    call: BeginCall,
    context: ChordContext
  ): Promise<Option.Option<string>> =>
    await api.commit(async (tx) => {
      const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
      const approvals = await tx.doc(Approvals, api.conversationId);
      const row = ledger.items[call.workflowId];

      if (row === undefined) {
        return Option.some(
          `workflow ${call.workflowId} is not in this thread's ledger`
        );
      }

      if (
        row.state === "running" &&
        row.codemodeTaskId === caller.codemodeTaskId
      ) {
        return Option.none<string>();
      }

      if (row.state !== "approved") {
        return Option.some(
          `workflow ${call.workflowId} is ${row.state}, not approved`
        );
      }

      const record = approvals.items[row.approvalId];

      if (record?.status !== "accepted") {
        return Option.some(
          `its launch approval ${row.approvalId} is ${record?.status ?? "missing"}, not accepted`
        );
      }

      if (row.scriptHash !== call.scriptHash) {
        return Option.some("the script is not the one the launch approved");
      }

      const at = api.now();

      row.state = "running";
      row.codemodeTaskId = caller.codemodeTaskId;
      row.startedAt = at;

      await tx.createTask(
        Watch,
        {
          workflowId: call.workflowId,
          nodeId: null,
          target: caller.codemodeTaskId,
        },
        BACKGROUND
      );

      await emit(tx, {
        name: "workflow.started",
        data: {
          workflowId: call.workflowId,
          codemodeTaskId: caller.codemodeTaskId,
        },
        at,
        context: Option.none(),
      });

      return Option.none<string>();
    }, context);

  const begin = defineTool({
    name: "workflow_begin",
    description:
      "Called by the workflow prelude as a script's first step: marks the approved workflow running. Not for direct use.",
    parameters: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeBegin(args);

      if (Option.isNone(call)) {
        return refused("workflow_begin: arguments are not the prelude's.");
      }

      const caller = await callerOf(api, context);

      if (Result.isFailure(caller)) {
        return refused(`workflow_begin refused: ${caller.failure}`);
      }

      const { workflowId, scriptHash, preludeVersion } = call.value;

      if (
        caller.success.workflowId !== workflowId ||
        caller.success.scriptHash !== scriptHash
      ) {
        return refused(
          `workflow_begin refused: this script call was launched as workflow ${caller.success.workflowId}, not ${workflowId}.`
        );
      }

      if (preludeVersion !== PRELUDE_VERSION) {
        return refused(
          `workflow_begin refused: the script carries prelude version ${String(preludeVersion)}, and this brain runs ${String(PRELUDE_VERSION)}.`
        );
      }

      const problem = await beginRow(api, caller.success, call.value, context);

      return Option.match(problem, {
        onSome: (text) => refused(`workflow_begin refused: ${text}.`),
        onNone: () => ({
          output: [{ type: "text", text: `Workflow ${workflowId} running.` }],
        }),
      });
    },
  });

  // agent and verify

  /**
   * Creates the node's child, owned by the node's own task, and its link, under the node's own
   * brief (`base.briefId`); with `watch`, also the row's watcher (a node that waited for its brief
   * has had one since its reserve).
   */
  const startChild = async (
    tx: Tx,
    api: ToolExecutionApi,
    row: WorkflowItemState,
    base: NodeItemState,
    resolved: ResolvedNodeModel,
    input: ReserveInput,
    watch: boolean,
    forkAt: Option.Option<EntryId>
  ): Promise<Reserved> => {
    const ownership = { kind: "task", taskId: api.taskId } as const;

    // A resumed node's child is a fork of the node it resumes, owned by this node's task like any
    // child, so a stop of this node reaches it and its usage starts at zero (`pi.usage` forks
    // initial). The fork carries none of the old child's Cairn documents (`cairn.child`,
    // `cairn.result` fork initial); `linkChild` writes them for this node.
    const child = await Option.match(
      Option.all({ target: input.dispatch.resume, at: forkAt }),
      {
        onNone: async () => await tx.createConversation({ ownership }),
        onSome: async ({ target, at }) =>
          await tx.forkConversation(target.conversationId, at, { ownership }),
      }
    );

    await configure(
      tx,
      child.id,
      childAgentOf(resolved, Option.isSome(input.dispatch.schema), input.cwd)
    );

    const childThreadId = childThreadIdOf(
      base.startedAt ?? api.now(),
      api.conversationId,
      base.requestId
    );

    const briefId = base.briefId ?? row.approvalId;

    await linkChild(tx, api.conversationId, child.id, {
      nodeId: input.nodeId,
      approvalId: briefId,
      childThreadId,
      schema: input.dispatch.schema,
      mode: input.mode,
      parentLink: input.parentLink,
    });

    const node: NodeItemState = {
      ...base,
      childThreadId,
      briefId,
      provider: resolved.provider,
      modelId: resolved.modelId,
      state: "running",
      stage: "child_created",
      conversationId: child.id,
    };

    row.nodes[input.nodeId] = node;

    if (watch) {
      await tx.createTask(
        Watch,
        { workflowId: row.id, nodeId: input.nodeId, target: api.taskId },
        BACKGROUND
      );
    }

    return { kind: "running", row: { ...node }, child: child.id };
  };

  /**
   * Reserves the node's row with its own brief, in one commit, or finds what an earlier attempt
   * made. A brief the launch's envelope covers is accepted by it, and the same commit creates the
   * child; one it does not cover waits for the user (ADR 0032).
   */
  const reserve = async (
    api: ToolExecutionApi,
    input: ReserveInput,
    context: ChordContext
  ): Promise<Reserved> =>
    await api.commit(async (tx): Promise<Reserved> => {
      // A table read, so before any write: pi-durable refuses a table read after a table write.
      const forkAt = await Option.match(input.dispatch.resume, {
        onNone: async () => await Promise.resolve(Option.none<EntryId>()),
        onSome: async (target) =>
          await latestEntryOf(tx, target.conversationId),
      });

      const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
      const approvals = await tx.doc(Approvals, api.conversationId);
      const row = ledger.items[input.dispatch.workflowId];
      const problem = runningProblem(row, input.caller);

      if (row === undefined || Option.isSome(problem)) {
        return {
          kind: "problem",
          text: Option.getOrElse(problem, () => "no workflow"),
        };
      }

      const existing = row.nodes[input.nodeId];

      if (existing !== undefined) {
        return foundOf(existing);
      }

      if (Option.isSome(input.dispatch.resume) && Option.isNone(forkAt)) {
        return {
          kind: "problem",
          text: resumeProblem(
            input.dispatch.resume.value.nodeId,
            "its conversation has no entries left to continue from"
          ),
        };
      }

      // Admission (WorkflowBudget.ts): the meter of this instant, read before any table write.
      const spends = await readSpends(tx, row, api.models, cache);
      const base = reservedRow(api, row, input);

      const metered = await applyMeter(tx, {
        conversationId: api.conversationId,
        row,
        approvals: approvals.items,
        spends,
        at: base.startedAt ?? api.now(),
      });

      if (metered.stopped && !faults.ignoreBudget) {
        return await refuseRow(tx, row, base, "budget_spent", null);
      }

      const envelope = Option.flatMap(
        Option.fromUndefinedOr(approvals.items[row.approvalId]),
        envelopeOf
      );

      const refusal = refusalOf(envelope, row, input);

      if (Option.isSome(refusal) || Option.isNone(envelope)) {
        const why = Option.getOrElse(
          refusal,
          (): NodeRefusal => "outside_grant"
        );

        // Only a role with no model carries the resolver's words; the other refusals speak for
        // themselves.
        const error =
          why === "no_provider" && Result.isFailure(input.model)
            ? input.model.failure
            : null;

        return await refuseRow(tx, row, base, why, error);
      }

      if (Result.isFailure(input.model)) {
        return await refuseRow(
          tx,
          row,
          base,
          "no_provider",
          input.model.failure
        );
      }

      const outside = faults.grantAll
        ? Option.none<Outside>()
        : briefWithin(envelope.value, askOf(row, input));

      const record = nodeRecordOf(api, row, input, outside);
      const node: NodeItemState = { ...base, briefId: record.id };

      approvals.items[record.id] = record;

      if (Option.isSome(outside)) {
        row.nodes[input.nodeId] = node;

        await tx.createTask(
          Watch,
          { workflowId: row.id, nodeId: input.nodeId, target: api.taskId },
          BACKGROUND
        );

        return { kind: "waiting", row: { ...node } };
      }

      const started = await startChild(
        tx,
        api,
        row,
        node,
        input.model.success,
        input,
        true,
        forkAt
      );

      await emitBriefApproved(tx, api.conversationId, record, api.now());

      return started;
    }, context);

  /**
   * After a waiting node's own brief settled, in one commit: Go creates its child under that brief;
   * Decline, Send back, an expiry or a stop ends the row `refused`, and the script sees `null`.
   */
  const admit = async (
    api: ToolExecutionApi,
    input: ReserveInput,
    context: ChordContext
  ): Promise<Reserved> =>
    await api.commit(async (tx): Promise<Reserved> => {
      // A table read, so before any write (as in `reserve`).
      const forkAt = await Option.match(input.dispatch.resume, {
        onNone: async () => await Promise.resolve(Option.none<EntryId>()),
        onSome: async (target) =>
          await latestEntryOf(tx, target.conversationId),
      });

      const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
      const approvals = await tx.doc(Approvals, api.conversationId);
      const row = ledger.items[input.dispatch.workflowId];
      const problem = runningProblem(row, input.caller);

      if (row === undefined || Option.isSome(problem)) {
        return {
          kind: "problem",
          text: Option.getOrElse(problem, () => "no workflow"),
        };
      }

      const node = row.nodes[input.nodeId];

      if (node === undefined) {
        return { kind: "problem", text: `node ${input.nodeId} has no row` };
      }

      if (!isWaitingNode(node)) {
        return foundOf(node);
      }

      if (Option.isSome(input.dispatch.resume) && Option.isNone(forkAt)) {
        return {
          kind: "problem",
          text: resumeProblem(
            input.dispatch.resume.value.nodeId,
            "its conversation has no entries left to continue from"
          ),
        };
      }

      const record = approvals.items[node.briefId ?? ""];

      if (record === undefined || record.status === "pending") {
        return { kind: "waiting", row: { ...node } };
      }

      const at = api.now();

      if (record.status === "accepted") {
        // Admission again at Go (WorkflowBudget.ts): the line may have been reached while the
        // card waited, and a waiting node has no child for the stopper to abort.
        const metered = await applyMeter(tx, {
          conversationId: api.conversationId,
          row,
          approvals: approvals.items,
          spends: await readSpends(tx, row, api.models, cache),
          at,
        });

        if (metered.stopped && !faults.ignoreBudget) {
          return await refuseRow(tx, row, node, "budget_spent", null, at);
        }

        return Result.isFailure(input.model)
          ? await refuseRow(
              tx,
              row,
              node,
              "no_provider",
              input.model.failure,
              at
            )
          : await startChild(
              tx,
              api,
              row,
              node,
              input.model.success,
              input,
              false,
              forkAt
            );
      }

      const envelope = Option.flatMap(
        Option.fromUndefinedOr(approvals.items[row.approvalId]),
        envelopeOf
      );

      const refusal = Option.match(envelope, {
        onNone: (): NodeRefusal => "outside_grant",
        onSome: (granted) => declinedRefusal(granted, row, input),
      });

      const reason = record.reason === null ? "" : `: ${record.reason}`;

      return await refuseRow(
        tx,
        row,
        node,
        refusal,
        `Its own brief was ${record.status}${reason}.`,
        at
      );
    }, context);

  /**
   * Holds node `nodeId` for its `attempt`th input until its usage limit resets (WorkflowBudget.ts):
   * the row `held` with the reset time, then `running` again with the attempt counted. A rerun
   * finds an attempt already counted and goes on at once, or a hold already written and keeps its
   * time. False when the workflow reached its budget's line meanwhile, or the row is not this
   * task's any more.
   */
  const holdNode = async (
    api: ToolExecutionApi,
    target: { readonly workflowId: string; readonly nodeId: string },
    attempt: number,
    resetAt: Option.Option<number>,
    context: ChordContext
  ): Promise<boolean> => {
    const { workflowId, nodeId } = target;

    const held = await api.commit(
      async (tx): Promise<Option.Option<number>> => {
        const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
        const node = ledger.items[workflowId]?.nodes[nodeId];

        if (
          node === undefined ||
          node.nestedTaskId !== api.taskId ||
          isNodeEnded(node.state)
        ) {
          return Option.none();
        }

        if (node.attempt >= attempt) {
          return Option.some(0);
        }

        // A hold written before a restart keeps its time.
        const stored = node.state === "held" ? node.held?.until : undefined;

        const until = Predicate.isNumber(stored)
          ? stored
          : Option.getOrElse(resetAt, () => api.now() + holdRetryMillis);

        node.state = "held";
        node.held = { until };

        return Option.some(until);
      },
      context
    );

    if (Option.isNone(held)) {
      return false;
    }

    while (api.now() < held.value) {
      // oxlint-disable-next-line no-await-in-loop -- one look per wait
      if (await atLine(api, workflowId, context)) {
        return false;
      }

      // oxlint-disable-next-line no-await-in-loop -- the hold's wait; a stop rejects it
      await sleep(
        Math.min(HOLD_POLL_MILLIS, held.value - api.now()),
        undefined,
        {
          signal: context.abortSignal,
        }
      );
    }

    if (await atLine(api, workflowId, context)) {
      return false;
    }

    return await api.commit(async (tx) => {
      const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
      const node = ledger.items[workflowId]?.nodes[nodeId];

      if (node === undefined || isNodeEnded(node.state)) {
        return false;
      }

      if (node.attempt < attempt) {
        node.state = "running";
        node.held = null;
        node.attempt = attempt;
      }

      return true;
    }, context);
  };

  /**
   * How the child ended: its value, or why the node failed. A node whose workflow is at its line
   * before its input went in sends nothing; one whose input went in (a rerun after a kill between
   * the submit and `markSubmitted`) waits for its child, which the stopper aborts. A child's run that a usage limit ended holds the node
   * until the limit resets, then the child is asked to go on (`-r<attempt>` request ids, so a rerun
   * finds each), at most `MAX_HOLDS` times.
   */
  const endingOf = async (
    api: ToolExecutionApi,
    row: NodeItemState,
    child: ConversationId,
    dispatch: Dispatch,
    context: ChordContext
  ): Promise<NodeEnding> => {
    const requestId = faults.freshDispatch
      ? `${row.requestId}-${String(api.now())}`
      : row.requestId;

    if (
      row.stage === "child_created" &&
      (await atLine(api, dispatch.workflowId, context)) &&
      !(await inputWentIn(api, child, requestId, context))
    ) {
      return Result.fail(BUDGET_STOP_TEXT);
    }

    let asked = await askChildFully(
      api,
      child,
      promptOf(dispatch),
      requestId,
      context,
      async (submission) => {
        await hold("after-submit", dispatch.label, context);
        await markSubmitted(
          api,
          dispatch.workflowId,
          row.id,
          submission,
          context
        );
      }
    );

    for (
      let attempt = 2;
      Result.isFailure(asked) && attempt <= MAX_HOLDS + 1;
      attempt += 1
    ) {
      const limit = usageLimitOf(
        asked.failure.detail,
        DateTime.makeUnsafe(api.now())
      );

      if (Option.isNone(limit)) {
        break;
      }

      // oxlint-disable-next-line no-await-in-loop -- one hold per limit, in order
      const resumed = await holdNode(
        api,
        { workflowId: dispatch.workflowId, nodeId: row.id },
        attempt,
        Option.map(limit.value.resetAt, DateTime.toEpochMillis),
        context
      );

      if (!resumed) {
        return Result.fail(BUDGET_STOP_TEXT);
      }

      // oxlint-disable-next-line no-await-in-loop
      asked = await askChildFully(
        api,
        child,
        CONTINUE_TEXT,
        `${requestId}-r${String(attempt)}`,
        context
      );
    }

    if (Result.isFailure(asked)) {
      return Result.fail(asked.failure.text);
    }

    const { answer, submission } = asked.success;

    if (Option.isNone(dispatch.schema)) {
      const value = await answerText(api, answer, context);

      return Result.succeed({ value, answer, schemaAttempts: 0, submission });
    }

    const typed = await typedResult(
      api,
      row.requestId,
      child,
      context,
      async () => {
        await hold("after-nudge", dispatch.label, context);
      },
      async () => !(await atLine(api, dispatch.workflowId, context))
    );

    return Result.map(typed, (found) => ({
      value: found.value,
      answer,
      schemaAttempts: found.attempts,
      submission,
    }));
  };

  /** What the reserve commit needs from outside it: the role's model and the thread's mode. */
  const reserveInput = async (
    api: ToolExecutionApi,
    caller: Caller,
    dispatch: Dispatch,
    record: Option.Option<ApprovalRecord>,
    context: ChordContext
  ): Promise<ReserveInput> => {
    const nodeId = faults.freshDispatch
      ? `${nodeIdOf(api.taskId)}-${String(api.now())}`
      : nodeIdOf(api.taskId);

    const ledger = await api.snapshot(
      WorkflowsDoc,
      api.conversationId,
      context
    );

    const known = ledger?.items[dispatch.workflowId]?.nodes[nodeId];

    // A rerun finds its row and resolves nothing again: the row records what the role resolved to.
    // A node waiting for its own brief has resolved nothing yet: its role resolves right before the
    // commit that creates its child (ADR 0035), after Go.
    const model =
      known === undefined || isWaitingNode(known)
        ? await resolveRole(dispatch.role, Option.flatMap(record, overridesOf))
        : Result.succeed<ResolvedNodeModel>({
            provider: known.provider ?? "",
            modelId: known.modelId ?? "",
            thinkingLevel: Option.none(),
          });

    const { mode } = await readPermissions(api, context);
    const agent = await api.agent(context);
    const link = await api.snapshot(ChildDoc, api.conversationId, context);

    return {
      nodeId,
      caller,
      dispatch,
      model,
      mode,
      cwd: Option.filter(
        Option.fromUndefinedOr(agent.cwd),
        (dir) => dir.trim() !== ""
      ),
      parentLink: isLinked(link)
        ? Option.some({ depth: link.depth, rootThreadId: link.rootThreadId })
        : Option.none(),
    };
  };

  /**
   * Waits for a node's own brief like any approval (ADR 0013: a rerun finds its record and waits
   * again), then admits or refuses the node, with its role resolved after the answer and the
   * thread's mode read again.
   */
  const awaitBrief = async (
    api: ToolExecutionApi,
    waiting: NodeItemState,
    input: ReserveInput,
    context: ChordContext
  ): Promise<Reserved> => {
    const settled = await Effect.runPromise(
      approvalLedger(api).awaitSettlement.pipe(Effect.result),
      { signal: context.abortSignal }
    );

    if (Result.isFailure(settled)) {
      return {
        kind: "problem",
        text: `node ${waiting.id}'s own brief could not be read: ${settled.failure.message}`,
      };
    }

    const launch = await launchRecordOf(
      api,
      input.dispatch.workflowId,
      context
    );

    const fresh = await stoppable(
      context,
      reserveInput(api, input.caller, input.dispatch, launch, context)
    );

    return await admit(api, fresh, context);
  };

  /** One node, from its reserve to its settle, holding one of its workflow's node slots. */
  const runHeld = async (
    api: ToolExecutionApi,
    input: ReserveInput,
    context: ChordContext
  ): Promise<ToolExecutionResult> => {
    const { dispatch } = input;
    const first = await reserve(api, input, context);

    const reserved =
      first.kind === "waiting"
        ? await awaitBrief(api, first.row, input, context)
        : first;

    if (reserved.kind === "waiting") {
      const tool = dispatch.verify ? "verify" : "agent";

      return refused(
        `${tool}: node ${reserved.row.id}'s own brief is still waiting for the user.`
      );
    }

    if (reserved.kind === "problem") {
      const tool = dispatch.verify ? "verify" : "agent";

      return refused(`${tool} refused: ${reserved.text}`);
    }

    if (reserved.kind === "ended") {
      return outcomeResult(await endedOutcome(api, reserved.row, context));
    }

    const { row, child } = reserved;

    await hold("after-reserve", dispatch.label, context);

    const workflow = await api.snapshot(
      WorkflowsDoc,
      api.conversationId,
      context
    );

    const stopMeter = await startMeter(
      api,
      dispatch.workflowId,
      child,
      minutesLineOf(workflow?.items[dispatch.workflowId]),
      context
    );

    let ending: NodeEnding;

    try {
      ending = await endingOf(api, row, child, dispatch, context);
    } finally {
      await stopMeter();
    }

    await hold("before-settle", dispatch.label, context);
    throwIfStopped(context.abortSignal);

    const settled = await settleNode(
      api,
      {
        caller: input.caller,
        nodeId: row.id,
        child,
        ending,
        verify: dispatch.verify,
      },
      { models: api.models, cache },
      context
    );

    if (Option.isSome(settled) && settled.value.state === "stopped") {
      return outcomeResult({
        status: "stopped",
        value: null,
        reason: settled.value.error,
        nodeId: row.id,
      });
    }

    return outcomeResult(outcomeOf(ending, row.id));
  };

  /** One node; the script gets its outcome, never its usage. */
  const runNode = async (
    api: ToolExecutionApi,
    caller: Caller,
    dispatch: Dispatch,
    context: ChordContext
  ): Promise<ToolExecutionResult> => {
    const record = await launchRecordOf(api, dispatch.workflowId, context);

    const input = await stoppable(
      context,
      reserveInput(api, caller, dispatch, record, context)
    );

    const limit = Option.match(Option.flatMap(record, envelopeOf), {
      onNone: () => 1,
      onSome: (granted) => granted.maxConcurrent,
    });

    const pool = slotsOf(dispatch.workflowId, limit);

    if (!(await pool.take(context.abortSignal))) {
      context.abortSignal?.throwIfAborted();

      return refused("agent: stopped while waiting for a node slot.");
    }

    try {
      return await runHeld(api, input, context);
    } finally {
      pool.release();
    }
  };

  const agent = defineTool({
    name: "agent",
    description:
      "Called by the workflow prelude's agent(): runs one node of the workflow as a child conversation. Not for direct use.",
    parameters: anyObject,
    structuredOutputSchema: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeAgent(args);

      if (Option.isNone(call)) {
        return refused("agent: arguments are not the prelude's.");
      }

      const given = call.value;

      const caller = await runningCaller(
        api,
        given.workflowId,
        "agent",
        context
      );

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      if (given.unknownOptions.length > 0) {
        return refused(
          `agent(): unknown options ${given.unknownOptions.join(", ")}.`
        );
      }

      const resume = await resumeTargetOf(
        api,
        given.workflowId,
        given.resume,
        context
      );

      if (Result.isFailure(resume)) {
        return refused(resume.failure);
      }

      const schema = nodeSchemaOf(given.schema);

      if (Result.isFailure(schema)) {
        return refused(schema.failure);
      }

      // A resumed node takes the default role unless the script names one, as the plan's dry run
      // records it: the envelope the user approved grants exactly that role at this call site.
      const role = Option.getOrElse(given.role, () => DEFAULT_NODE_ROLE);

      const effort = optionalText(given.effort, PHASE_TITLE_LIMIT);

      if (!isRoleSpec(role)) {
        return refused(roleProblem("agent", role));
      }

      if (Option.isSome(effort) && !isThinkingLevel(effort.value)) {
        return refused(
          `agent(): effort \`${summaryOf(effort.value)}\` is not one of off, minimal, low, medium, high, xhigh, max.`
        );
      }

      return await runNode(
        api,
        caller.success,
        {
          workflowId: given.workflowId,
          prompt: given.prompt,
          label: labelOf(given.label, given.prompt),
          phase: optionalText(given.phase, PHASE_TITLE_LIMIT),
          role,
          schema: schema.success,
          key: optionalText(given.key, KEY_LIMIT),
          readonly: given.readonly,
          effort,
          verify: false,
          resume: resume.success,
        },
        context
      );
    },
  });

  const verify = defineTool({
    name: "verify",
    description:
      "Called by the workflow prelude's verify(): checks one result against a claim in a fresh child. Not for direct use.",
    parameters: anyObject,
    structuredOutputSchema: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeVerify(args);

      if (Option.isNone(call)) {
        return refused("verify: arguments are not the prelude's.");
      }

      const given = call.value;

      const caller = await runningCaller(
        api,
        given.workflowId,
        "verify",
        context
      );

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      const claim = Option.getOrElse(
        given.claim,
        () => "The result is correct and complete."
      );

      const role = Option.getOrElse(given.role, () => DEFAULT_VERIFY_ROLE);

      if (!isRoleSpec(role)) {
        return refused(roleProblem("verify", role));
      }

      return await runNode(
        api,
        caller.success,
        {
          workflowId: given.workflowId,
          prompt: verifyPrompt(claim, given.result),
          label: labelOf(given.label, `Verify: ${claim}`),
          phase: optionalText(given.phase, PHASE_TITLE_LIMIT),
          role,
          schema: Option.some(VERDICT_SCHEMA),
          key: Option.none(),
          readonly: true,
          effort: Option.none(),
          verify: true,
          resume: Option.none(),
        },
        context
      );
    },
  });

  // approve, phase, log, budget

  const approve = defineTool({
    name: "approve",
    description:
      "Called by the workflow prelude's approve(): asks the user and waits for the answer. Not for direct use.",
    parameters: anyObject,
    structuredOutputSchema: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeApprove(args);

      if (Option.isNone(call)) {
        return refused("approve: arguments are not the prelude's.");
      }

      const caller = await runningCaller(
        api,
        call.value.workflowId,
        "approve",
        context
      );

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      const choices = Option.filter(
        call.value.options,
        (labels) => labels.length > 0
      );

      if (
        Option.isSome(choices) &&
        choices.value.length > MAX_APPROVE_OPTIONS
      ) {
        return refused(
          `approve(): at most ${String(MAX_APPROVE_OPTIONS)} options, and this call gave ${String(choices.value.length)}.`
        );
      }

      const ledger = approvalLedger(api);

      const request = approveRequest(
        cutSummary(call.value.summary.trim()),
        Option.map(choices, (labels) => labels.map(summaryOf))
      );

      const settlement = await Effect.runPromise(
        Effect.gen(function* () {
          yield* ledger.ask(request);

          return yield* ledger.awaitSettlement;
        }).pipe(Effect.result),
        { signal: context.abortSignal }
      );

      if (Result.isFailure(settlement)) {
        return refused(`approve: ${settlement.failure.message}`);
      }

      const approvals = await api.snapshot(
        Approvals,
        api.conversationId,
        context
      );

      const answer = approvals?.items[ledger.approvalId]?.answer ?? null;
      const decision: ApprovalDecision | null = answer?.decision ?? null;
      const choice = answer?.answers?.[0]?.picks[0] ?? null;

      const accepted =
        settlement.success.status === "accepted" && decision !== "decline";

      const text = accepted
        ? `Approved${choice === null ? "" : `: ${choice}`}.`
        : `Not approved (${settlement.success.status}).`;

      return {
        output: [{ type: "text", text }],
        structuredOutput: { accepted, choice },
      };
    },
  });

  const phase = defineTool({
    name: "phase",
    description:
      "Called by the workflow prelude's phase(): records a phase. Not for direct use.",
    parameters: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodePhase(args);

      if (Option.isNone(call)) {
        return refused("phase: arguments are not the prelude's.");
      }

      const { workflowId } = call.value;
      const caller = await runningCaller(api, workflowId, "phase", context);

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      const title = call.value.title.trim().slice(0, PHASE_TITLE_LIMIT);

      await api.commit(async (tx) => {
        const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
        const row = ledger.items[workflowId];

        if (
          row !== undefined &&
          title !== "" &&
          !row.phases.some((known) => known.title === title)
        ) {
          row.phases.push({ title, detail: null });
        }
      }, context);

      return { output: [{ type: "text", text: `Phase ${title}.` }] };
    },
  });

  const log = defineTool({
    name: "log",
    description:
      "Called by the workflow prelude's log(): writes a line to the workflow's log. Not for direct use.",
    parameters: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeLog(args);

      if (Option.isNone(call)) {
        return refused("log: arguments are not the prelude's.");
      }

      const { workflowId } = call.value;
      const caller = await runningCaller(api, workflowId, "log", context);

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      const text = call.value.text.slice(0, LOG_LINE_LIMIT);
      const key = String(api.taskId);

      await api.commit(async (tx) => {
        const ledger = await tx.doc(WorkflowsDoc, api.conversationId);
        const row = ledger.items[workflowId];

        if (row !== undefined && row.log[key] === undefined) {
          row.log[key] = { at: api.now(), text };
        }
      }, context);

      return { output: [{ type: "text", text: "Logged." }] };
    },
  });

  const budget = defineTool({
    name: "budget",
    description:
      "Called by the workflow prelude's budget: reads what the workflow spent. Not for direct use.",
    parameters: anyObject,
    structuredOutputSchema: anyObject,
    callers: ["tools"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      throwIfStopped(context.abortSignal);

      const call = decodeBudget(args);

      if (Option.isNone(call)) {
        return refused("budget: arguments are not the prelude's.");
      }

      const { workflowId } = call.value;
      const caller = await runningCaller(api, workflowId, "budget", context);

      if (Result.isFailure(caller)) {
        return refused(caller.failure);
      }

      const ledger = await api.snapshot(
        WorkflowsDoc,
        api.conversationId,
        context
      );

      const approvals = await api.snapshot(
        Approvals,
        api.conversationId,
        context
      );

      const row = ledger?.items[workflowId];

      const spent =
        row === undefined ? 0 : await spentTokens(api, row, context);

      const records = approvals?.items ?? {};

      const ceiling =
        row === undefined
          ? null
          : effectiveBudget(row, records).budget.maxTokens;

      // At the line, whichever limit it was, nothing is left.
      const stopped = row !== undefined && budgetStopped(row, records);

      const left = ceiling === null ? null : Math.max(0, ceiling - spent);
      const remaining = stopped ? 0 : left;

      return {
        output: [{ type: "text", text: `Spent ${String(spent)} tokens.` }],
        structuredOutput: { spent, remaining },
      };
    },
  });

  return {
    order: ExtensionOrder.workflows,
    extension: defineExtension({
      name: WORKFLOWS_EXTENSION,
      tools: [
        planTool(plan, resolveRole),
        begin,
        agent,
        verify,
        approve,
        phase,
        log,
        budget,
      ],
      hooks: [workflowGate],
      tasks: [Watch, BudgetStopper, budgetPushTask(push ?? NO_BUDGET_PUSH)],
    }),
  };
};
