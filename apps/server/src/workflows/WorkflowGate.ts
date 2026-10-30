// The workflow gate (ADR 0012 as amended, ADR 0032, workflows note W3 "Launching"): a `beforeTool`
// hook on every tool call of a conversation that selects the workflows extension.
//
// - A model's `codemode` call whose source is a workflow script (`export const meta = ...` first),
//   or a recipe reference that names one (`resolveRecipe`), runs only when the thread's ledger holds an `approved` row for that exact source (its hash). The
//   hook then rewrites the source behind the prelude (`rewriteScript`), baking in the row's id,
//   sample, token ceiling and arguments, and marks the call's own task with `GATE_MEMO`. pi-durable
//   stores the rewritten source in the call's start data, so a replay runs what this hook wrote,
//   and the hook does not run again. Any other workflow script is blocked with a refusal the model
//   can act on.
// - A node tool called by the model directly is blocked. A node tool called from a script is left
//   to the node tools, which check what a hook cannot see (the calling task's gate mark), because a
//   hook can be left out of a selection (spec section 12, "guards left out of a selection").
//
// The gate decides by the approved row's hash, never by `isRewrittenWorkflow`: a model that pastes
// a prelude-shaped script gets no mark, so `workflow_begin` refuses it. Hooks may read documents and
// memos and must not wait on anything else. Ported in intent from `CodeMode.ts`'s `deadlineGuard`
// and the workflows probe's `brain2.ts` (a `beforeTool` rewrite of the code mode call).

import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type {
  HookApi,
  HookRegistration,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { hook, ToolTask } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { Effect, Exit, Option, Predicate } from "effect";

import { NODE_TOOLS, rewriteScript } from "./Prelude.ts";
import { WorkflowsDoc } from "./WorkflowDocs.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowDocs.ts";
import {
  isWorkflowSource,
  parseWorkflowScript,
  resolveRecipe,
} from "./WorkflowScript.ts";
import type { WorkflowScript } from "./WorkflowScript.ts";

/**
 * The memo the gate writes on a `codemode` call's task when it lets a workflow run: which workflow
 * the call is. `workflow_begin` and every node read it on their calling task. Prefixed, since hooks
 * share the task's memo namespace (spec section 12, "hook memo names").
 */
export const GATE_MEMO = "cairn.workflow-gate";

/** What `GATE_MEMO` holds. */
export interface GateMark {
  [key: string]: JsonValue;
  workflowId: string;
  scriptHash: string;
}

/** What the model is told when it calls a node tool itself. */
export const NODE_TOOL_REFUSAL = (name: string) =>
  `${name} runs only inside an approved workflow script, called by the prelude. Write the workflow as a codemode script and launch it after its plan is approved.`;

/** What the model is told when its workflow script has no approved launch. */
export const UNAPPROVED_REFUSAL = (name: string) =>
  `Workflow ${name} has no approved launch for this exact script. Propose it with workflow_plan and wait for Go, then run the same script with codemode; a script changed after Go needs a new launch.`;

const isNodeTool = (name: string): boolean =>
  NODE_TOOLS.some((tool) => tool === name);

/** The first approved row of `ledger` bound to `hash`, in the order the rows were proposed. */
export const approvedRowFor = (
  ledger: Readonly<WorkflowsState> | undefined,
  hash: string
): Option.Option<WorkflowItemState> =>
  Option.fromUndefinedOr(
    Object.values(ledger?.items ?? {}).find(
      (row) => row.state === "approved" && row.scriptHash === hash
    )
  );

/** The source a row lets run, rewritten behind the prelude with what the launch baked in. */
export const bakedSource = (
  script: WorkflowScript,
  row: Readonly<WorkflowItemState>
): string =>
  rewriteScript(script, {
    workflowId: row.id,
    sample: Option.fromNullOr(row.sample),
    budgetTokens: Option.fromNullOr(row.budget.maxTokens),
    args: row.args,
  });

/** The gate's decision for one call: pass, block with a text, or run with new arguments. */
const decide = async (
  call: ToolHookCall,
  api: HookApi,
  context: ChordContext
): Promise<
  | undefined
  | { readonly block: string }
  | { readonly arguments: { [key: string]: JsonValue } }
> => {
  if (isNodeTool(call.name)) {
    return call.parent === undefined
      ? { block: NODE_TOOL_REFUSAL(call.name) }
      : undefined;
  }

  if (call.name !== CODEMODE_TOOL_NAME || call.parent !== undefined) {
    return undefined;
  }

  const { code } = call.arguments;

  if (!Predicate.isString(code) || !isWorkflowSource(code)) {
    return undefined;
  }

  // A recipe reference runs the recipe it names: the approved hash is the recipe's own.
  const parsed = Effect.runSyncExit(
    Effect.flatMap(resolveRecipe(code), parseWorkflowScript)
  );

  if (Exit.isFailure(parsed)) {
    const failure = Exit.findErrorOption(parsed);

    return {
      block: Option.match(failure, {
        onNone: () => "Workflow script cannot be read.",
        onSome: (refusal) => refusal.message,
      }),
    };
  }

  const script = parsed.value;
  const ledger = await api.snapshot(WorkflowsDoc, api.conversationId, context);
  const row = approvedRowFor(ledger, script.hash);

  if (Option.isNone(row)) {
    return { block: UNAPPROVED_REFUSAL(script.meta.name) };
  }

  const mark = await api.memo<GateMark>(
    GATE_MEMO,
    { workflowId: row.value.id, scriptHash: script.hash },
    context
  );

  // A retry of this hook before the call's intent was recorded finds its own mark; another
  // workflow's mark on this task is a wiring fault, and the call is blocked rather than misfiled.
  if (mark.workflowId !== row.value.id) {
    return {
      block: `This codemode call is already bound to workflow ${mark.workflowId}; run workflow ${row.value.id} as its own call.`,
    };
  }

  return {
    arguments: { ...call.arguments, code: bakedSource(script, row.value) },
  };
};

/** The gate hook, installed with the workflows extension. */
export const workflowGate: HookRegistration = hook(ToolTask, {
  beforeTool: decide,
});
