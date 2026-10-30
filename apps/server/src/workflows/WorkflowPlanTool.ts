// `workflow_plan` (ADR 0032, workflows note W4 "Launching"): the model proposes a workflow, the user
// sees its plan and says Go, Run on 1 first or Decline, and only then may the same script run.
//
// The tool is replay-safe and its task is the wait (ADR 0013). It parses and dry-runs the script
// (`WorkflowPlan`, no model called), estimates it from the thread's own past nodes on each role's
// current binding, and in one commit writes the `proposed` ledger row, the launch approval (a
// `brief` record whose frozen payload is the plan and its envelope, id `call-<task id>`) and the
// `workflow.proposed` event. Then it waits for the answer like any gated call; boot retries a task
// whose approval is pending. A rerun after `kill -9` finds its row and record and waits again
// without dry-running twice.
//
// The answering commit moves the row (`launchAnswered`); an expiry is applied here, once the wait
// ends, and a stop (or the boot repair after one a crash cut off) declines it in the commit that
// cancels the record (`heldByRun` counts a launch as its task's), so a row never stays `proposed`
// after its record settled. Go tells the model to call `codemode` with exactly the same script: the
// gate runs only the hash the user approved.

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { RoleSpec } from "@cairn/protocol/Roles";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { defineTool } from "@earendil-works/pi-durable";
import { Effect, Option, Result, Schema } from "effect";

import {
  approvalIdOf,
  approvalLedger,
  Approvals,
  copyRecord,
  UNDECIDED,
} from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { emit } from "../brain/Events.ts";
import { cutSummary, readPermissions } from "../brain/Permissions.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import {
  proposedRecord,
  resultRefOf,
  workflowIdOf,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowDocs.ts";
import {
  applyLaunchAnswer,
  LAUNCH_TOOL,
  LAUNCH_TTL_MILLIS,
  SAMPLE_SIZE,
} from "./WorkflowLaunch.ts";
import { refused } from "./WorkflowNodes.ts";
import { estimateRun, toLaunch } from "./WorkflowPlan.ts";
import type { DryRun, NodeHistory, PlanInput } from "./WorkflowPlan.ts";
import type { RoleResolver } from "./WorkflowTools.ts";

/** Parses and dry-runs a proposed script: the run, or the refusal's words for the model. */
export interface PlanAccess {
  readonly dryRun: (
    source: string,
    input: PlanInput
  ) => Promise<Result.Result<DryRun, string>>;
}

/** What the tool tells the model about writing and launching a workflow. */
export const PLAN_DESCRIPTION = [
  "Propose a workflow script for the user's Go before running it. A workflow fans work out to subagent nodes from code: the script starts with `export const meta = { name, description, phases: [{ title }] };` and then calls agent(prompt, { role, schema, label, phase, readonly }), verify(result, { claim }), parallel([...thunks]), pipeline(items, ...stages), phase(title), log(text), approve({ summary }) and reads args and budget.",
  "agent() and verify() resolve with the node's value, or null when the node was refused, stopped or failed, so handle null. A node without a schema answers text; in the dry run every node answers at once with a placeholder shaped by its schema.",
  "A built-in recipe runs by name: propose `export const meta = { name: \"council\" };` with its args and, on Go, run that same line with codemode. The council takes { question, scope, nonGoals, evidence, advisors: [two to four roles], judge?, maxPasses? }. A project recipe (its path from workflow.list) is proposed whole, as its file's script. agent()'s resume option continues a settled node of the same run in a fork of its conversation; a resumed node takes the default role unless it names one.",
  "This tool dry-runs the script with stub nodes, shows the user its call sites, node count, estimate and budget, and waits for the answer. On Go, call codemode with exactly the same script, unchanged: any change needs a new proposal. Run on 1 first runs it with pipeline() taking only its first item; propose it again to run on all. A node the plan did not show (another role, a writer where it showed a reader, more nodes than it counted) asks the user before it starts.",
].join(" ");

const decodeLaunch = Schema.decodeUnknownOption(WorkflowLaunch);

const encodeLaunch = Schema.encodeSync(WorkflowLaunch);

/** The budget a proposal asks for: tokens and list-price dollars, the rest the default's. */
const budgetFrom = (
  maxTokens: number | undefined,
  maxUsd: number | undefined
): Budget => ({
  ...DEFAULT_BUDGET,
  maxTokens: maxTokens ?? null,
  maxListMicros:
    maxUsd === undefined ? null : Micros.make(Math.round(maxUsd * 1_000_000)),
});

/**
 * The settled nodes of the thread's past workflows each role's estimate rests on: only those that
 * ran on the provider and model the role resolves to now, oldest first.
 */
const historyOf = async (
  ledger: Readonly<WorkflowsState> | undefined,
  run: DryRun,
  resolveRole: RoleResolver
): Promise<ReadonlyArray<NodeHistory>> => {
  const bound = new Map<string, { spec: RoleSpec; binding: string }>();

  for (const { spec } of run.byRole) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of roles, resolved in order
    const resolved = await resolveRole(spec, Option.none());

    if (Result.isSuccess(resolved)) {
      bound.set(spec, {
        spec,
        binding: `${resolved.success.provider}/${resolved.success.modelId}`,
      });
    }
  }

  return Object.values(ledger?.items ?? {})
    .flatMap((row) => Object.values(row.nodes))
    .filter((node) => node.state === "settled" && node.receipt !== null)
    .toSorted((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    .flatMap((node): Array<NodeHistory> => {
      const role = bound.get(node.role ?? "");

      return role === undefined ||
        role.binding !== `${node.provider ?? ""}/${node.modelId ?? ""}` ||
        node.receipt === null
        ? []
        : [
            {
              spec: role.spec,
              totalTokens: node.receipt.totalTokens,
              listMicros: Option.fromNullOr(node.receipt.listMicros),
            },
          ];
    });
};

/** The launch approval record for `launch`, pending, as the plan's commit writes it. */
const launchRecord = (
  api: ToolExecutionApi,
  launch: WorkflowLaunch
): ApprovalRecord => {
  const askedAt = api.now();
  const { count, unbounded } = launch.nodes;

  return {
    id: approvalIdOf(api.taskId),
    toolTaskId: api.taskId,
    tool: LAUNCH_TOOL,
    kind: "brief",
    summary: cutSummary(
      `Run workflow ${launch.name}: ${unbounded ? "at least " : ""}${String(count)} node${count === 1 ? "" : "s"}`
    ),
    status: "pending",
    askedAt,
    expiresAt: askedAt + LAUNCH_TTL_MILLIS,
    answeredAt: null,
    run: null,
    executorRequestId: null,
    ...UNDECIDED,
    payload: jsonRecordOf(encodeLaunch(launch)),
  };
};

/** A detached copy of a row, safe to read after its transaction ends. */
const copyRow = (row: Readonly<WorkflowItemState>): WorkflowItemState => ({
  ...row,
  budget: {
    ...row.budget,
    planGuard:
      row.budget.planGuard === null ? null : { ...row.budget.planGuard },
  },
});

/** What the model reads once the user answered. */
const answerText = (
  row: Readonly<WorkflowItemState>,
  record: Readonly<ApprovalRecord>
): string => {
  const reason = record.reason === null ? "" : `: ${record.reason}`;

  if (row.state === "approved" || record.status === "accepted") {
    const sample =
      row.sample === null
        ? ""
        : ` to run on ${String(SAMPLE_SIZE)} item first (pipeline() takes only its first item; propose it again afterwards to run on all, with nothing carried over)`;

    return `Go: workflow ${row.id} (${row.name}) is approved${sample}. Now call codemode with exactly the same script, unchanged. A node the plan did not show will ask the user before it starts.`;
  }

  if (record.status === "expired") {
    return `The launch of workflow ${row.name} expired without an answer. Nothing ran; do not run the script.`;
  }

  if (record.status === "cancelled") {
    return `The launch of workflow ${row.name} was cancelled. Nothing ran; do not run the script.`;
  }

  return `The user declined workflow ${row.name}${reason}. Nothing ran; do not run the script.`;
};

/** Applies a settled record to a row still `proposed` (an expiry, a stop); reads both back. */
const settle = async (api: ToolExecutionApi, context: ChordContext) =>
  await api.commit(async (tx) => {
    const rows = await tx.doc(WorkflowsDoc, api.conversationId);
    const approvals = await tx.doc(Approvals, api.conversationId);
    const row = rows.items[workflowIdOf(api.taskId)];
    const record = approvals.items[approvalIdOf(api.taskId)];

    if (row !== undefined && record !== undefined) {
      applyLaunchAnswer(row, record);
    }

    return row === undefined || record === undefined
      ? Option.none()
      : Option.some({ row: copyRow(row), record: copyRecord(record) });
  }, context);

/** `workflow_plan`, over the dry run and the role resolver. */
export const planTool = (plan: PlanAccess, resolveRole: RoleResolver) => {
  /** Dry-runs, then writes the row, the record and the event once; the refusal's words otherwise. */
  const propose = async (
    api: ToolExecutionApi,
    args: {
      readonly script: string;
      readonly args?: JsonValue;
      readonly max_tokens?: number;
      readonly max_usd?: number;
      readonly max_nodes?: number;
    },
    context: ChordContext
  ): Promise<Option.Option<string>> => {
    const workflowId = workflowIdOf(api.taskId);

    const ledger = await api.snapshot(
      WorkflowsDoc,
      api.conversationId,
      context
    );

    // A rerun finds what its first attempt proposed, and dry-runs nothing again.
    if (ledger?.items[workflowId] !== undefined) {
      return Option.none();
    }

    const launchArgs: Schema.Json = args.args ?? {};
    const budget = budgetFrom(args.max_tokens, args.max_usd);

    const run = await plan.dryRun(args.script, {
      args: launchArgs,
      budget,
      sample: Option.none(),
    });

    if (Result.isFailure(run)) {
      return Option.some(run.failure);
    }

    const history = await historyOf(ledger, run.success, resolveRole);
    const { mode } = await readPermissions(api, context);

    const launch = toLaunch(run.success, {
      workflowId,
      // The script stays in this call's own arguments.
      scriptRef: resultRefOf(api.taskId),
      args: launchArgs,
      budget,
      estimate: Option.some(estimateRun(run.success, history)),
      roleOverrides: {},
      maxNodes: Option.fromUndefinedOr(args.max_nodes),
      modes: [mode],
      writes: [],
    });

    await api.commit(async (tx) => {
      const rows = await tx.doc(WorkflowsDoc, api.conversationId);
      const approvals = await tx.doc(Approvals, api.conversationId);
      const record = launchRecord(api, launch);

      if (rows.items[workflowId] !== undefined) {
        return;
      }

      rows.items[workflowId] = proposedRecord({
        launch,
        approvalId: record.id,
        sample: Option.none(),
      });
      approvals.items[record.id] = record;

      await emit(tx, {
        name: "workflow.proposed",
        data: {
          workflowId,
          approvalId: record.id,
          scriptHash: launch.scriptHash,
        },
        at: record.askedAt,
        context: Option.none(),
      });
    }, context);

    return Option.none();
  };

  return defineTool({
    name: LAUNCH_TOOL,
    description: PLAN_DESCRIPTION,
    parameters: Type.Object({
      script: Type.String({
        description:
          "The whole workflow script, starting with `export const meta = {...}`.",
      }),
      args: Type.Optional(
        Type.Unsafe<JsonValue>({
          description:
            "Launch arguments the script reads as `args`: plain JSON, small (paths and ids, not file contents).",
        })
      ),
      max_tokens: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "A token budget for the whole workflow.",
        })
      ),
      max_usd: Type.Optional(
        Type.Number({
          exclusiveMinimum: 0,
          description: "A list-price dollar budget for the whole workflow.",
        })
      ),
      max_nodes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1000,
          description:
            "How many nodes Go covers; by default the dry run's count. Nodes past it ask the user.",
        })
      ),
    }),
    structuredOutputSchema: Type.Unsafe<{ [key: string]: JsonValue }>({
      type: "object",
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args, api, context): Promise<ToolExecutionResult> => {
      const problem = await propose(api, args, context);

      if (Option.isSome(problem)) {
        return refused(problem.value);
      }

      const settlement = await Effect.runPromise(
        approvalLedger(api).awaitSettlement.pipe(Effect.result),
        { signal: context.abortSignal }
      );

      if (Result.isFailure(settlement)) {
        return refused(`workflow_plan: ${settlement.failure.message}`);
      }

      const settled = await settle(api, context);

      if (Option.isNone(settled)) {
        return refused(
          "workflow_plan: the proposal's row or record is missing. Propose it again."
        );
      }

      const { row, record } = settled.value;
      const approved = row.state === "approved";

      const maxNodes = Option.map(
        Option.flatMap(Option.fromNullOr(record.payload), decodeLaunch),
        (found) => found.envelope.maxNodes
      );

      return {
        output: [{ type: "text", text: answerText(row, record) }],
        structuredOutput: {
          approved,
          workflowId: row.id,
          sample: row.sample,
          budget: { ...row.budget },
          maxNodes: Option.getOrNull(maxNodes),
        },
      };
    },
  });
};
