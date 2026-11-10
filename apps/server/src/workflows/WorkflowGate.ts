// The workflow gate (ADR 0012 as amended, ADR 0032, workflows note W3 "Launching"): a `beforeTool`
// hook on every tool call of a conversation that selects the workflows extension.
//
// - A model's `codemode` call whose source is a workflow script (`export const meta = ...` first),
//   or a recipe reference that names one (a built-in's by `resolveRecipe`, a project recipe's by the
//   source its launch kept, `WorkflowSourcesDoc`), runs only the row a `workflow_plan` call of the
//   same run proposed and the user approved: the first `approved` row, in proposal order, that is
//   bound to the live run (`LaunchRunsDoc`, `pi.live.run.first`) and holds that exact source (its
//   hash; for a project recipe, its kept source by name). A row of a run that ended is no standing
//   grant: it runs from no later run, and its launch watcher declines it (`WorkflowLaunch.ts`). Two
//   approved rows of one script in one run are two launches, run one per call in proposal order,
//   also when the model makes the calls in one message: the n-th call of a tool round that names a
//   script takes the n-th of its rows, counting a row an earlier call of the round already began
//   (`roundOf`), so calls that run side by side never take the same row. A hook cannot write a
//   document, so this order, read from the round's assistant entry, is what keeps them apart.
//   The hook then rewrites the source behind the prelude (`rewriteScript`), baking in the row's id,
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

import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  HookApi,
  HookRegistration,
  LiveState,
  ToolHookCall,
} from "@earendil-works/pi-durable";
import { hook, LiveDoc, ToolTask } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import { Effect, Exit, Option, Predicate, Result } from "effect";

import type { DurableRunner } from "../brain/Durable.ts";
import { NODE_TOOLS, rewriteScript } from "./Prelude.ts";
import {
  BUILT_IN_RECIPES,
  recipeReferenceOf,
} from "./recipes/BuiltInRecipes.ts";
import {
  isLaunchOfRun,
  LaunchRunsDoc,
  WorkflowSourcesDoc,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type {
  LaunchRunsState,
  WorkflowItemState,
  WorkflowSourcesState,
  WorkflowsState,
} from "./WorkflowDocs.ts";
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
  `Workflow ${name} has no approved launch for this exact script in this run. Propose it with workflow_plan and wait for Go, then run the same script with codemode; a script changed after Go, or a launch approved in an earlier run, needs a new launch.`;

const isNodeTool = (name: string): boolean =>
  NODE_TOOLS.some((tool) => tool === name);

/** What the gate reads to pick a row: the ledger, the run bindings and the live run. */
export interface GateView {
  readonly ledger: Readonly<WorkflowsState> | undefined;
  readonly runs: Readonly<LaunchRunsState> | undefined;
  /** The live run's first entry; none when no run is live. */
  readonly run: Option.Option<number>;
  /** The tasks of this tool round's `codemode` calls made before this one. */
  readonly earlier: ReadonlySet<number>;
}

/**
 * The rows the live run's calls of this round launch from, in the order they were proposed: the
 * run's approved rows, and those an earlier call of the round already began, so a row keeps its
 * place while that call runs it.
 */
const launchable = (view: GateView): ReadonlyArray<WorkflowItemState> =>
  Object.values(view.ledger?.items ?? {}).filter(
    (row) =>
      isLaunchOfRun(view.runs, row.id, view.run) &&
      (row.state === "approved" ||
        (row.codemodeTaskId !== null && view.earlier.has(row.codemodeTaskId)))
  );

/**
 * The row the `nth` call of this round that names `script` takes (0 for the first): the `nth` of
 * `rows`, while it is still approved. None when there is no such row, or an earlier call took it.
 */
const nthApproved = <A extends { readonly row: WorkflowItemState }>(
  rows: ReadonlyArray<A>,
  nth: number
): Option.Option<A> =>
  Option.filter(
    Option.fromUndefinedOr(rows[nth]),
    (each) => each.row.state === "approved"
  );

/**
 * The approved row of the live run that holds the script `hash` and that the `nth` call of the
 * round naming that script takes, in proposal order.
 */
export const approvedRowFor = (
  view: GateView,
  hash: string,
  nth: number
): Option.Option<WorkflowItemState> =>
  Option.map(
    nthApproved(
      launchable(view)
        .filter((row) => row.scriptHash === hash)
        .map((row) => ({ row })),
      nth
    ),
    (each) => each.row
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

/**
 * The approved row of the live run that launches the project recipe `name` and that the `nth` call
 * of the round naming it takes, in proposal order, with the source its launch was proposed with
 * (kept beside the ledger); none when the run has no such launch.
 */
export const projectLaunchFor = (
  view: GateView,
  sources: Readonly<WorkflowSourcesState> | undefined,
  name: string,
  nth: number
): Option.Option<{
  readonly row: WorkflowItemState;
  readonly source: string;
}> =>
  nthApproved(
    launchable(view).flatMap((row) => {
      const kept = sources?.items[row.id];

      return kept?.name === name ? [{ row, source: kept.source }] : [];
    }),
    nth
  );

/**
 * Reads `code` as a workflow script (a built-in reference as the recipe it names), through
 * `runner`; the refusal's words when it cannot be read.
 */
const scriptOf = (
  runner: DurableRunner,
  code: string
): Result.Result<WorkflowScript, string> => {
  const parsed = runner.syncExit(
    Effect.flatMap(resolveRecipe(code), parseWorkflowScript)
  );

  if (Exit.isFailure(parsed)) {
    return Result.fail(
      Option.match(Exit.findErrorOption(parsed), {
        onNone: () => "Workflow script cannot be read.",
        onSome: (refusal) => refusal.message,
      })
    );
  }

  return Result.succeed(parsed.value);
};

/** How many tool results and other entries may follow a round's assistant entry while it runs. */
const ROUND_SLACK = 32;

/**
 * What a `codemode` source launches, for counting the calls of a round that launch the same thing:
 * a project recipe by name, or a script by its hash; none for anything the gate does not run.
 */
const launchKeyOf = (
  runner: DurableRunner,
  code: string
): Option.Option<string> => {
  if (!isWorkflowSource(code)) {
    return Option.none();
  }

  const named = Option.filter(
    recipeReferenceOf(code),
    (name) => !BUILT_IN_RECIPES.has(name)
  );

  if (Option.isSome(named)) {
    return Option.some(`recipe:${named.value}`);
  }

  return Option.map(
    Result.getSuccess(scriptOf(runner, code)),
    (script) => `script:${script.hash}`
  );
};

/**
 * Where `call`, whose source is `code`, stands in its tool round: how many `codemode` calls before
 * it launch the same thing (`nth`), and the tasks of every `codemode` call before it (`earlier`).
 * The calls' sources come from the round's assistant entry, the newest one that holds `call`, and
 * their tasks from `pi.live`'s tool slots. A call alone in its round, or one whose entry is not
 * found, is first.
 */
const roundOf = async (
  runner: DurableRunner,
  call: ToolHookCall,
  code: string,
  live: Readonly<LiveState> | undefined,
  api: HookApi,
  context: ChordContext
): Promise<{ readonly nth: number; readonly earlier: ReadonlySet<number> }> => {
  const slots = live?.tools ?? [];
  const at = slots.findIndex((slot) => slot.callId === call.id);

  const before = slots
    .slice(0, Math.max(at, 0))
    .filter((slot) => slot.name === CODEMODE_TOOL_NAME);

  if (before.length === 0) {
    return { nth: 0, earlier: new Set() };
  }

  const page = await api.entries(
    { order: "descending" },
    slots.length + ROUND_SLACK,
    undefined,
    context
  );

  const sources = new Map<string, string>();

  for (const entry of page.items) {
    const message = entry.model?.[0];

    if (
      message?.role === "assistant" &&
      message.content.some(
        (part) => part.type === "toolCall" && part.id === call.id
      )
    ) {
      for (const part of message.content) {
        const source: unknown =
          part.type === "toolCall" ? part.arguments.code : undefined;

        if (part.type === "toolCall" && Predicate.isString(source)) {
          sources.set(part.id, source);
        }
      }

      break;
    }
  }

  const own = launchKeyOf(runner, code);

  return {
    nth: before.filter((slot) => {
      const source = sources.get(slot.callId);

      return (
        source !== undefined &&
        Option.exists(own, (key) =>
          Option.contains(launchKeyOf(runner, source), key)
        )
      );
    }).length,
    earlier: new Set(
      before.flatMap((slot) =>
        slot.taskId === undefined ? [] : [Number(slot.taskId)]
      )
    ),
  };
};

/** Lets `script` run as `row`: marks the call's task and bakes the row in. */
const run = async (
  script: WorkflowScript,
  row: Readonly<WorkflowItemState>,
  call: ToolHookCall,
  api: HookApi,
  context: ChordContext
): Promise<
  | { readonly block: string }
  | { readonly arguments: { [key: string]: JsonValue } }
> => {
  const mark = await api.memo<GateMark>(
    GATE_MEMO,
    { workflowId: row.id, scriptHash: script.hash },
    context
  );

  // A retry of this hook before the call's intent was recorded finds its own mark; another
  // workflow's mark on this task is a wiring fault, and the call is blocked rather than misfiled.
  if (mark.workflowId !== row.id) {
    return {
      block: `This codemode call is already bound to workflow ${mark.workflowId}; run workflow ${row.id} as its own call.`,
    };
  }

  return {
    arguments: { ...call.arguments, code: bakedSource(script, row) },
  };
};

/**
 * The gate's decision for one call: pass, block with a text, or run with new arguments. A workflow
 * script's launch leaves a lifecycle line through `runner`: admitted, or refused and why.
 */
const decide = async (
  runner: DurableRunner,
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

  /** The launch's lifecycle line: `refused` with why, or `admitted` as workflow `workflowId`. */
  const decided = (
    outcome: "admitted" | "refused",
    workflowId: string | null,
    why: string | null
  ) => {
    runner.line(`workflow launch ${outcome}`, {
      event: "workflow_launch_gated",
      conversationId: api.conversationId,
      callId: call.id,
      outcome,
      workflowId,
      why,
    });
  };

  /** Blocks the launch with `text`, logging it refused for `why`. */
  const refuse = (why: string, text: string) => {
    decided("refused", null, why);

    return { block: text };
  };

  /** Runs `script` as `row`, logging the launch admitted unless the mark binds another. */
  const admit = async (
    script: WorkflowScript,
    row: Readonly<WorkflowItemState>
  ) => {
    const ran = await run(script, row, call, api, context);

    const bound = Predicate.hasProperty(ran, "block");

    decided(
      bound ? "refused" : "admitted",
      row.id,
      bound ? "task-bound-to-another-workflow" : null
    );

    return ran;
  };

  const live = await api.snapshot(LiveDoc, api.conversationId, context);
  const round = await roundOf(runner, call, code, live, api, context);

  const view: GateView = {
    ledger: await api.snapshot(WorkflowsDoc, api.conversationId, context),
    runs: await api.snapshot(LaunchRunsDoc, api.conversationId, context),
    run: Option.fromUndefinedOr(live?.run?.first),
    earlier: round.earlier,
  };

  // A reference to a project recipe runs the launch of that name its run proposed, with the
  // source that launch was approved with, which the plan kept beside the ledger; with no approved
  // launch of that name in this run it runs nothing.
  const named = Option.filter(
    recipeReferenceOf(code),
    (name) => !BUILT_IN_RECIPES.has(name)
  );

  if (Option.isSome(named)) {
    const sources = await api.snapshot(
      WorkflowSourcesDoc,
      api.conversationId,
      context
    );

    const launch = projectLaunchFor(view, sources, named.value, round.nth);

    if (Option.isNone(launch)) {
      return refuse("unapproved", UNAPPROVED_REFUSAL(named.value));
    }

    const kept = scriptOf(runner, launch.value.source);

    return Result.isFailure(kept)
      ? refuse("unreadable", kept.failure)
      : await admit(kept.success, launch.value.row);
  }

  // A built-in recipe reference runs the recipe it names: the approved hash is the recipe's own.
  const read = scriptOf(runner, code);

  if (Result.isFailure(read)) {
    return refuse("unreadable", read.failure);
  }

  const row = approvedRowFor(view, read.success.hash, round.nth);

  if (Option.isNone(row)) {
    return refuse("unapproved", UNAPPROVED_REFUSAL(read.success.meta.name));
  }

  return await admit(read.success, row.value);
};

/** The gate hook, installed with the workflows extension, running its Effects through `runner`. */
export const workflowGate = (runner: DurableRunner): HookRegistration =>
  hook(ToolTask, {
    beforeTool: async (call, api, context) =>
      await decide(runner, call, api, context),
  });
