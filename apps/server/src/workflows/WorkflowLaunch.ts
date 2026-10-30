// A workflow's launch approval and its envelope (ADR 0032, workflows note W4, briefs note B8).
//
// `workflow_plan` freezes the dry run's plan in a `brief` record whose payload is a
// `WorkflowLaunch`, beside a `proposed` ledger row. The answer lands in one commit
// (`launchAnswered`, run by `answerApproval` inside the answering transaction): Go moves the row to
// `approved` with who decided and when; Run on 1 first (`accept_sample`) does the same with
// `sample` 1, so the gate bakes `SAMPLE = 1` and `pipeline` takes one item (a separate, full run
// with nothing carried over); the card's edits (`launch`) replace the row's budget, and the role
// overrides are read from the answer by `overridesOf`; Decline, an expiry or a stop marks the row
// `declined`. The frozen payload stays as the model proposed it.
//
// Every node of a running workflow is a brief. `briefWithin` decides whether the launch's envelope
// covers it (the role and whether it writes, the thread's mode, the node cap): a node inside is
// recorded as an accepted brief with `decidedBy` envelope in the commit that dispatches it; a node
// outside raises its own brief card and waits for the user like any approval. So every dispatched
// row of the ledger names an accepted brief, and `ledgerProblems` checks it.

import { ApprovalId } from "@cairn/protocol/Ids";
import { ThinkingLevel } from "@cairn/protocol/Models";
import { Brief, LaunchEdits } from "@cairn/protocol/Policy";
import type { Envelope, RuntimeMode } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import type { Budget } from "@cairn/protocol/Spend";
import type { NodeRefusal } from "@cairn/protocol/Workflows";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import {
  Approvals,
  cancelRecord,
  isLaunchRecord,
  UNDECIDED,
} from "../brain/CairnDocs.ts";
import type { ApprovalRecord, JsonRecord } from "../brain/CairnDocs.ts";
import { emit } from "../brain/Events.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import {
  approveRecord,
  declineRow,
  launchOf,
  NODE_BRIEF_TOOLS,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type {
  BudgetState,
  NodeItemState,
  WorkflowItemState,
} from "./WorkflowDocs.ts";

/** How many items `pipeline` takes when the user says Run on 1 first. */
export const SAMPLE_SIZE = 1;

/** How long a launch approval or a node's own brief stays answerable: a brief's week. */
export const LAUNCH_TTL_MILLIS = 7 * 24 * 60 * 60 * 1000;

/** The tool of a workflow's launch approval. */
export const LAUNCH_TOOL = "workflow_plan";

const decodeEdits = Schema.decodeUnknownOption(LaunchEdits);

const encodeBrief = Schema.encodeSync(Brief);

/** A protocol budget as a ledger row keeps it. */
export const budgetStateOf = (budget: Budget): BudgetState => ({
  maxListMicros: budget.maxListMicros,
  maxTokens: budget.maxTokens,
  maxTurns: budget.maxTurns,
  maxMinutes: budget.maxMinutes,
  planGuard: budget.planGuard === null ? null : { ...budget.planGuard },
  warnAt: budget.warnAt,
});

/** The card's edits an answer carries; none when the user ran the plan as proposed. */
export const editsOf = (record: ApprovalRecord): Option.Option<LaunchEdits> =>
  record.answer?.launch === null || record.answer?.launch === undefined
    ? Option.none()
    : decodeEdits(record.answer.launch);

/**
 * Applies a launch approval's answer to its `proposed` row, in place: Go or Run on 1 first approve
 * it (with the sample and any edited budget), anything else declines it. False when the row has
 * left `proposed` (answered already) or the record is still pending.
 */
export const applyLaunchAnswer = (
  row: WorkflowItemState,
  record: ApprovalRecord
): boolean => {
  if (row.state !== "proposed" || record.status === "pending") {
    return false;
  }

  if (record.status !== "accepted") {
    return declineRow(row, record);
  }

  const at = record.answeredAt ?? record.askedAt;

  approveRecord(
    row,
    record.decidedBy === null ? { kind: "user" } : { ...record.decidedBy },
    at
  );
  row.sample = record.answer?.decision === "accept_sample" ? SAMPLE_SIZE : null;

  for (const edits of Option.toArray(editsOf(record))) {
    row.budget = budgetStateOf(edits.budget);
  }

  return true;
};

/**
 * The answering commit's part for a workflow's launch (`answerApproval`'s `answered` hook): the row
 * its payload names takes the answer, so Go and the approved row land together. Nothing for any
 * other record.
 */
export const launchAnswered = async (
  tx: Tx,
  conversationId: ConversationId,
  record: ApprovalRecord
): Promise<void> => {
  const launch = isLaunchRecord(record) ? launchOf(record) : Option.none();

  if (Option.isNone(launch)) {
    return;
  }

  const ledger = await tx.doc(WorkflowsDoc, conversationId);
  const row = ledger.items[launch.value.workflowId];

  if (row !== undefined) {
    applyLaunchAnswer(row, record);
  }
};

// The envelope.

/** How wide each mode is: a grant of a mode covers every narrower one. */
const MODE_WIDTH: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/** What a node asks of its envelope. */
export interface NodeAsk {
  readonly role: string;
  readonly readonly: boolean;
  /** The mode its child would run in: the launching thread's, now. */
  readonly mode: RuntimeMode;
  /** Nodes of the workflow dispatched or waiting before this one. */
  readonly dispatched: number;
}

/** Why a node is outside its envelope: the refusal it ends with if declined, and the card's words. */
export interface Outside {
  readonly refusal: NodeRefusal;
  readonly why: string;
}

/**
 * Whether the launch's envelope covers a node (ADR 0032): a role granted with the same arms, as a
 * writer for a writer (a writer grant covers a reader of that role); a mode no wider than the
 * widest granted (no modes granted covers any); and room under the node cap. None when it fits.
 */
export const briefWithin = (
  envelope: Envelope,
  node: NodeAsk
): Option.Option<Outside> => {
  if (node.dispatched >= envelope.maxNodes) {
    return Option.some({
      refusal: "node_cap",
      why: `the launch covered ${String(envelope.maxNodes)} node${envelope.maxNodes === 1 ? "" : "s"}, and this is one more`,
    });
  }

  const roles = envelope.roles.filter(
    (role) => role.spec === node.role && role.arms === "host"
  );

  if (roles.length === 0) {
    return Option.some({
      refusal: "outside_grant",
      why: `the launch did not show role ${node.role}`,
    });
  }

  if (!node.readonly && roles.every((role) => role.readonly)) {
    return Option.some({
      refusal: "outside_grant",
      why: `the launch showed ${node.role} reading only, and this node may write`,
    });
  }

  const widest = Math.max(
    ...envelope.modes.map((mode) => MODE_WIDTH[mode]),
    -1
  );

  if (envelope.modes.length > 0 && MODE_WIDTH[node.mode] > widest) {
    return Option.some({
      refusal: "outside_grant",
      why: `the thread now runs in ${node.mode}, wider than the launch granted (${envelope.modes.join(", ")})`,
    });
  }

  return Option.none();
};

/** What a node's own brief is made from. */
export interface NodeBriefInput {
  readonly workflowName: string;
  readonly label: string;
  readonly prompt: string;
  readonly role: string;
  readonly effort: Option.Option<string>;
  readonly readonly: boolean;
  readonly mode: RuntimeMode;
  readonly budget: Budget;
  readonly resultSchema: Option.Option<JsonRecord>;
  /** Why it needs its own card; none when its envelope covers it. */
  readonly outside: Option.Option<Outside>;
}

const isThinkingLevel = Schema.is(ThinkingLevel);

/** A text cut to `limit` characters, with an ellipsis when cut. */
const cut = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/**
 * How much of a covered node's prompt its brief keeps: its child's first input holds the whole
 * prompt, and a fan-out of hundreds of nodes would otherwise carry every prompt twice on the thread's
 * stream. A card the user must answer keeps the prompt whole (up to the wire's display limit).
 */
const COVERED_TASK_LIMIT = 280;

/** The brief a node runs under, as a record's payload freezes it. */
export const nodeBriefPayload = (input: NodeBriefInput): JsonRecord | null => {
  const why = Option.match(input.outside, {
    onNone: () =>
      `A node of workflow ${input.workflowName}, covered by its launch's envelope.`,
    onSome: (outside) =>
      `Workflow ${input.workflowName} reached a node its launch did not cover: ${outside.why}. Go runs this one node; Decline skips it, and the script goes on without its result.`,
  });

  const thinking = Option.filter(input.effort, isThinkingLevel);

  return jsonRecordOf(
    encodeBrief(
      Brief.make({
        type: "brief",
        title: cut(
          input.label.trim() === "" ? "Workflow node" : input.label,
          80
        ),
        task: cut(
          input.prompt,
          Option.isNone(input.outside) ? COVERED_TASK_LIMIT : 4096
        ),
        why: cut(why, 4096),
        avoid: [],
        doneWhen: [
          {
            text: "The workflow script accepts the result.",
            judge: { kind: "user" },
          },
        ],
        workspace: "shared",
        base: null,
        writes: [],
        role: RoleSpec.make(input.role),
        model: null,
        thinking: Option.getOrNull(thinking),
        mode: input.mode,
        mayCommit: !input.readonly,
        budget: input.budget,
        resultSchema: Option.getOrNull(input.resultSchema),
        wake: "quiet",
        decisions: [],
      })
    )
  );
};

/** What a node's brief record is made from. */
export interface NodeRecordInput {
  readonly id: string;
  readonly toolTaskId: number;
  readonly tool: string;
  readonly summary: string;
  readonly at: number;
  readonly payload: JsonRecord | null;
  /** The launch approval whose envelope accepts it; none raises its own card. */
  readonly envelope: Option.Option<string>;
}

/**
 * A node's brief record: accepted by its envelope (`decidedBy` envelope, the launch approval's id),
 * or pending, waiting for the user.
 */
export const nodeBriefRecord = (input: NodeRecordInput): ApprovalRecord => {
  const accepted = Option.isSome(input.envelope);

  return {
    id: input.id,
    toolTaskId: input.toolTaskId,
    tool: input.tool,
    kind: "brief",
    summary: input.summary,
    status: accepted ? "accepted" : "pending",
    askedAt: input.at,
    expiresAt: input.at + LAUNCH_TTL_MILLIS,
    answeredAt: accepted ? input.at : null,
    run: null,
    executorRequestId: null,
    ...UNDECIDED,
    payload: input.payload,
    answer: accepted
      ? { decision: "accept", answers: null, note: null, launch: null }
      : null,
    decidedBy: Option.match(input.envelope, {
      onNone: () => null,
      onSome: (approvalId) => ({
        kind: "envelope",
        approvalId: ApprovalId.make(approvalId),
      }),
    }),
    reason: accepted ? "Covered by the workflow's launch." : null,
  };
};

/** Whether a record is a workflow node's own brief, which only its node acts on. */
export const isNodeBrief = (record: ApprovalRecord): boolean =>
  record.kind === "brief" && NODE_BRIEF_TOOLS.has(record.tool);

/** Whether a node waits for its own brief: reserved, no child yet, a brief named. */
export const isWaitingNode = (node: Readonly<NodeItemState>): boolean =>
  node.state === "reserved" &&
  node.conversationId === null &&
  node.briefId !== null;

/**
 * Ends a node that still waits for its own brief, in its watcher's commit, once the node's task
 * ended (stopped, or failed before its brief was answered): its brief is cancelled (`decidedBy`
 * system, run stopped: nothing will run it now) and the row `stopped`, with its event.
 */
export const closeWaiting = async (
  tx: Tx,
  conversationId: ConversationId,
  row: WorkflowItemState,
  node: NodeItemState,
  at: number
): Promise<void> => {
  if (!isWaitingNode(node)) {
    return;
  }

  const approvals = await tx.doc(Approvals, conversationId);
  const record = approvals.items[node.briefId ?? ""];

  if (record?.status === "pending") {
    cancelRecord(record, at, "run-stopped");
  }

  node.state = "stopped";
  node.endedAt = at;
  node.error = "stopped while it waited for its own brief";

  await emit(tx, {
    name: "workflow.node.stopped",
    data: { workflowId: row.id, nodeId: node.id, state: node.state },
    at,
    context: Option.none(),
  });
};
