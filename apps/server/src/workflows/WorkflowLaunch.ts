// A workflow's launch approval and its envelope (ADR 0032, workflows note W4, briefs note B8).
//
// `workflow_plan` freezes the dry run's plan in a `brief` record whose payload is a
// `WorkflowLaunch`, beside a `proposed` ledger row. The answer lands in one commit
// (`launchAnswered`, run by `answerApproval` inside the answering transaction): Go moves the row to
// `approved` with who decided and when; Run on 1 first (`accept_sample`) does the same with
// `sample` 1, so the gate bakes `SAMPLE = 1` and `pipeline` takes one item (a separate, full run
// with nothing carried over); the card's edits (`launch`) replace the row's budget; Decline, an
// expiry or a stop marks the row `declined`. The frozen payload stays as the model proposed it.
// A launch is bound to the run that proposed it (`LaunchRunsDoc`): the gate runs it only from that
// run, and Go's launch watcher (`LaunchWatch`) declines it when that run ends before it ran.
//
// Every node of a running workflow is a brief. `briefWithin` decides whether the launch's envelope
// covers it (the model it runs on and whether it writes, the thread's mode, the node cap). The
// envelope grants per model, not per call site (ADR 0043 and ADR 0032, amended 2026-11-09): a node
// from any call site fits when its model is one the launch showed. A node inside is
// recorded as an accepted brief with `decidedBy` envelope in the commit that dispatches it; a node
// outside raises its own brief card and waits for the user like any approval. So every dispatched
// row of the ledger names an accepted brief, and `ledgerProblems` checks it.

import { ApprovalId } from "@cairn/protocol/Ids";
import { ThinkingLevel } from "@cairn/protocol/Models";
import type { ModelRef } from "@cairn/protocol/Models";
import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { Brief, LaunchEdits } from "@cairn/protocol/Policy";
import type { Envelope, RuntimeMode } from "@cairn/protocol/Policy";
import type { Budget } from "@cairn/protocol/Spend";
import type { NodeRefusal } from "@cairn/protocol/Workflows";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import { defineTask, LiveDoc } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";

import {
  Approvals,
  cancelRecord,
  isLaunchRecord,
  UNDECIDED,
} from "../brain/CairnDocs.ts";
import type {
  ApprovalPayloadState,
  ApprovalRecord,
  JsonRecord,
} from "../brain/CairnDocs.ts";
import { emit } from "../brain/Events.ts";
import { modelOfSpec, modelText } from "../models/ModelSpecs.ts";
import { plainCopy } from "../subagents/SubagentDocs.ts";
import {
  approveRecord,
  declineRow,
  endApprovedRow,
  LaunchRunsDoc,
  launchOf,
  NODE_BRIEF_TOOLS,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type {
  BudgetState,
  LaunchRunsState,
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

/** The run a launch is bound to, by its first entry; none for a planted or unbound launch. */
const boundRunOf = (
  runs: Readonly<LaunchRunsState>,
  workflowId: string
): Option.Option<number> =>
  Option.fromNullOr(runs.items[workflowId]?.run ?? null);

/** The launch watcher's task name. */
export const LAUNCH_WATCH_TASK = "cairn.workflow-launch-watch";

/**
 * The launch watcher (`cairn.workflow-launch-watch`), a background task Go creates beside its
 * approved row: it follows the run the launch was proposed in, one generation at a time
 * (`pi.live.run.taskId` passes from each to the next while `first` stays), and once that run has
 * ended with the row still approved (the model never ran it, or the user stopped the run first) it
 * declines the row, decided by the system as `run-stopped`. So an approved launch is never a
 * standing grant (ADR 0032 as amended). A rerun after `kill -9` looks again from the start.
 */
export const LaunchWatch = defineTask<
  { workflowId: string },
  { phase: "watch" },
  null
>({
  name: LAUNCH_WATCH_TASK,
  version: 1,
  initial: () => ({ phase: "watch" }),
  phases: {
    watch: async (task, runtime, context) => {
      const { workflowId } = task.input;

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- one look per generation of the run
        const ledger = await runtime.snapshot(
          WorkflowsDoc,
          runtime.conversationId,
          context
        );

        // oxlint-disable-next-line no-await-in-loop
        const runs = await runtime.snapshot(
          LaunchRunsDoc,
          runtime.conversationId,
          context
        );

        // oxlint-disable-next-line no-await-in-loop
        const live = await runtime.snapshot(
          LiveDoc,
          runtime.conversationId,
          context
        );

        const bound = boundRunOf(runs ?? { items: {} }, workflowId);

        // The launch's run, while it is still the live one.
        const current = Option.filter(
          Option.fromUndefinedOr(live?.run),
          (each) =>
            Option.exists(Option.fromUndefinedOr(each.first), (first) =>
              Option.contains(bound, first)
            )
        );

        if (
          ledger?.items[workflowId]?.state !== "approved" ||
          Option.isNone(current)
        ) {
          break;
        }

        // oxlint-disable-next-line no-await-in-loop -- the run's current generation
        await runtime.waitForTask(current.value.taskId, context);
      }

      await runtime.commit(async (tx) => {
        const ledger = await tx.doc(WorkflowsDoc, runtime.conversationId);
        const row = ledger.items[workflowId];

        // The run ended: a row it never ran ends with it. One that ran, or ended, stays as it is.
        if (row !== undefined) {
          endApprovedRow(row, "run-stopped", runtime.now());
        }

        return {
          status: "terminal",
          outcome: { status: "completed", result: null },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  },
});

/**
 * The answering commit's part for a workflow's launch (`answerApproval`'s `answered` hook): the row
 * its payload names takes the answer, so Go and the approved row land together. Go also creates the
 * row's launch watcher (`LaunchWatch`), which declines the row if its run ends before it runs, and
 * supersedes every approved row of the same script that another run left (one whose run ended
 * before the watcher could end it, or one written before launches were bound to runs). An approved
 * row of the same run is another launch the user wants, and stays. Nothing for any other record.
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
  const runs = await tx.doc(LaunchRunsDoc, conversationId);
  const row = ledger.items[launch.value.workflowId];

  if (row === undefined || !applyLaunchAnswer(row, record)) {
    return;
  }

  if (row.state !== "approved") {
    return;
  }

  const at = record.answeredAt ?? record.askedAt;
  const run = boundRunOf(runs, row.id);

  for (const other of Object.values(ledger.items)) {
    const sameRun = Option.exists(run, (own) =>
      Option.contains(boundRunOf(runs, other.id), own)
    );

    if (
      other.id !== row.id &&
      other.scriptHash === row.scriptHash &&
      !sameRun
    ) {
      endApprovedRow(other, "superseded", at);
    }
  }

  if (Option.isSome(run)) {
    await tx.createTask(
      LaunchWatch,
      { workflowId: row.id },
      { ownership: { kind: "conversation" }, conversationId, background: true }
    );
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
  /** The model its child runs on (its level aside). */
  readonly model: ModelRef;
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
 * Whether the launch's envelope covers a node (ADR 0032, keyed by model per ADR 0043): its model
 * granted anywhere in the launch, whichever call site showed it (the envelope grants per model,
 * not per call site), with the same arms, the level aside, as a writer for a writer (a writer
 * grant covers a reader on that model); a mode no wider than the widest granted (no modes granted
 * covers any); and room under the node cap. None when it fits.
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

  const wanted = modelText(node.model);

  const grants = envelope.models.filter(
    (entry) =>
      entry.arms === "host" &&
      Option.exists(
        modelOfSpec(entry.spec),
        (model) => modelText(model) === wanted
      )
  );

  if (grants.length === 0) {
    return Option.some({
      refusal: "outside_grant",
      why: `the launch did not show model ${wanted}`,
    });
  }

  if (!node.readonly && grants.every((entry) => entry.readonly)) {
    return Option.some({
      refusal: "outside_grant",
      why: `the launch showed ${wanted} reading only, and this node may write`,
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
  /** The model spec the script named; none runs on the launching thread's model. */
  readonly spec: Option.Option<string>;
  readonly effort: Option.Option<string>;
  readonly readonly: boolean;
  readonly mode: RuntimeMode;
  readonly budget: Budget;
  readonly resultSchema: Option.Option<JsonRecord>;
  /** Why it needs its own card; none when its envelope covers it. */
  readonly outside: Option.Option<Outside>;
}

const isThinkingLevel = Schema.is(ThinkingLevel);

const decodeSpec = Schema.decodeOption(ModelSpec);

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
export const nodeBriefPayload = (
  input: NodeBriefInput
): ApprovalPayloadState => {
  const why = Option.match(input.outside, {
    onNone: () =>
      `A node of workflow ${input.workflowName}, covered by its launch's envelope.`,
    onSome: (outside) =>
      `Workflow ${input.workflowName} reached a node its launch did not cover: ${outside.why}. Go runs this one node; Decline skips it, and the script goes on without its result.`,
  });

  const thinking = Option.filter(input.effort, isThinkingLevel);

  return plainCopy(
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
        // Only a named model is frozen, for the card to check; none runs on the launching thread's.
        model: Option.getOrNull(Option.flatMap(input.spec, decodeSpec)),
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
  readonly payload: ApprovalPayloadState | null;
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
