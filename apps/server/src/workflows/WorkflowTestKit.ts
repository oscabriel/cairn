// A workflow brain for tests and the workflow judges: a real pi-durable Harness with Cairn's code
// mode extension (its `WaitingSandbox` and slot pools), the workflows extension and its gate, and
// the results extension, over pi-ai's faux provider. Never the deployed brain.
//
// The faux model plays every part from what it is sent:
//
// - The launching thread's model is sent `RUN:` and a script; it calls `codemode` with that script
//   once, then answers `done` with the tool's result. Sent `PLAN:` it proposes the script with
//   `workflow_plan` first and runs it on Go; `PLAN ONLY:` proposes and answers without running it;
//   `PLAN TWICE:` proposes it twice in one message, with arguments `{ question: "first" }` and
//   `{ question: "second" }`, then runs it once per Go, one call per round; `PLAN TWICE TOGETHER:`
//   proposes it the same way, then runs both launches with two `codemode` calls in one message.
// - A node's child is sent a prompt that opens `node:<label>` with flags: it first calls the judge's
//   `work` tool (one effect, logged once per child, `ms=` long, deaf to an abort for `deaf=` ms),
//   then answers. `typed` answers with `submit_result`, `lazy` ends without it the first time (so
//   the nudge is due; with `nudgems=` it first calls `pause` that long, so a kill lands while it
//   answers the nudge), `bad` submits an invalid value every time, `fail` ends its run with a
//   provider error, `text` (the default) answers `{"label":...}` as text.
//   `limit` and `limitreset` end the run after the work on a provider's usage limit (OpenCode Go's,
//   naming no reset, or Codex's, resetting at once) until the node's second input arrives.
// - A `verify` node's child (its prompt opens "Check one claim") submits `verified`.
//
// Launches are planted the way 5A's answer path will write them: the script is parsed and
// dry-run (`WorkflowPlan`), its launch payload frozen in an accepted `brief` approval record, and an
// `approved` row written beside it, in one host commit.

import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";

import { ConversationId as StoredConversationId } from "@cairn/protocol/Ids";
import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { Envelope, RuntimeMode } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type {
  AssistantMessage,
  Message,
  Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type {
  ConversationId,
  Harness,
  Storage,
} from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness as DurableHarness,
} from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME } from "@earendil-works/pi-durable/codemode";
import {
  DateTime,
  Effect,
  Function,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { Type } from "typebox";

import { Approvals, UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { CodeMode } from "../brain/CodeMode.ts";
import { messageText } from "../brain/CommitFeed.ts";
import { errorText } from "../brain/Durable.ts";
import {
  EVENT_KIND_PREFIX,
  EventsDoc,
  isEventObject,
  reactOnce,
  reactorKinds,
  registerCursors,
} from "../brain/Events.ts";
import type { Reactor } from "../brain/Events.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { FAILURE_WORDS, parseModelSpec } from "../models/ModelSpecs.ts";
import { RESULT_TOOL_NAME, ResultTool } from "../models/ResultTool.ts";
import { plainCopy } from "../subagents/SubagentDocs.ts";
import { fixedDefaultBudget } from "../usage/DefaultBudget.ts";
import { NO_BUDGET_PUSH } from "./WorkflowBudget.ts";
import type { BudgetPushSink } from "./WorkflowBudget.ts";
import {
  approveRecord,
  LaunchRunsDoc,
  proposedRecord,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import { LAUNCH_TOOL } from "./WorkflowLaunch.ts";
import { toLaunch, WorkflowPlan } from "./WorkflowPlan.ts";
import { planAccess } from "./Workflows.ts";
import { parseWorkflowScript } from "./WorkflowScript.ts";
import { workflowExtension } from "./WorkflowTools.ts";
import type {
  HoldPoint,
  ModelResolver,
  WorkflowFaultSet,
} from "./WorkflowTools.ts";

/** The faux provider and model every conversation of the kit runs on. */
export const KIT_MODEL = { provider: "faux", modelId: "kit" } as const;

/** The kit root thread's thinking level, which a node that names no model runs at. */
export const KIT_LEVEL = "medium" as const;

/** The spec a kit node that names no model runs on: the root thread's model and level. */
export const KIT_SPEC = `${KIT_MODEL.provider}/${KIT_MODEL.modelId}:${KIT_LEVEL}`;

/** A second model the kit's faux provider serves: what a node that names another model runs on. */
export const ALT_MODEL = `${KIT_MODEL.provider}/kit-alt`;

/** The kit root thread's cwd, which every node's child must work in too. */
export const KIT_CWD = tmpdir();

/** How long a kit node held by a limit that names no reset waits: short, so a test sees it. */
export const KIT_HOLD_RETRY_MILLIS = 400;

/** A model the kit's resolver refuses, as `ModelSpecs` refuses one with no usable credential. */
export const UNREADY_MODEL = "faux/unready";

/** The kit's model named at thinking level `low`. */
export const LOW_MODEL = `${KIT_MODEL.provider}/${KIT_MODEL.modelId}:low`;

/** What opens a launching thread's input: the script to run follows. */
export const RUN_PREFIX = "RUN:\n";

/**
 * What opens a launching thread's input that proposes its script first: the model calls
 * `workflow_plan`, runs the script with `codemode` on Go, and after a Run on 1 first proposes it
 * once more to run on all.
 */
export const PLAN_PREFIX = "PLAN:\n";

/** What opens an input whose model proposes its script and, on Go, answers without running it. */
export const PLAN_ONLY_PREFIX = "PLAN ONLY:\n";

/**
 * What opens an input whose model proposes its script twice in one message, with different
 * arguments (`TWICE_ARGS`), then runs it with `codemode` once per Go, one call per round.
 */
export const PLAN_TWICE_PREFIX = "PLAN TWICE:\n";

/**
 * What opens an input whose model proposes its script twice in one message, as `PLAN_TWICE_PREFIX`
 * does, then, after both Goes, runs it with two `codemode` calls in one message (one tool round).
 */
export const PLAN_TWICE_TOGETHER_PREFIX = "PLAN TWICE TOGETHER:\n";

/** The arguments of the two proposals a `PLAN_TWICE_PREFIX` input makes, in call order. */
export const TWICE_ARGS = [{ question: "first" }, { question: "second" }];

/** The judge tool every node's child calls first. */
export const WORK_TOOL = "work";

/** A tool that only waits, with no effect: a lazy child's pause before it answers its nudge. */
export const PAUSE_TOOL = "pause";

/**
 * Resolves a spec as `Workflows.ts` does over `ModelSpecs`, with no catalog: `UNREADY_MODEL` to its
 * refusal, any other spec to the model and level it names.
 */
export const kitResolver: ModelResolver = async (spec) => {
  const named = parseModelSpec(spec);

  if (spec === UNREADY_MODEL || Option.isNone(named)) {
    return await Promise.resolve(
      Result.fail(
        `ModelSpecs.resolve refused "${spec}": ${FAILURE_WORDS.missing_credential}.`
      )
    );
  }

  return await Promise.resolve(
    Result.succeed({
      spec,
      provider: named.value.model.provider,
      modelId: named.value.model.modelId,
      thinkingLevel: named.value.level,
    })
  );
};

/** One line of a node's outside effect: the `work` tool's start and end. */
export interface WorkEffect {
  readonly node: string;
  readonly what: "start" | "done" | "aborted";
}

/** What a kit brain is built with. */
export interface KitOptions {
  readonly faults: WorkflowFaultSet;
  readonly hold: (point: HoldPoint, label: string) => Promise<void>;
  /** Called for each `work` effect, outside pi-durable's store. */
  readonly effect: (line: WorkEffect) => void;
  readonly tokensPerSecond: number;
  /** Where the soft line's push goes; none sends nothing. */
  readonly push?: BudgetPushSink;
  /** Project recipes a reference may name, source by name; none when absent. */
  readonly projectRecipes?: Readonly<Record<string, string>>;
  /** The server's default budget a proposal starts from; no limit when absent. */
  readonly defaultBudget?: Budget;
}

/** The flags of a node prompt: `node:<label> typed ms=200`. */
interface NodeFlags {
  readonly label: string;
  readonly flags: ReadonlySet<string>;
  readonly ms: number;
  readonly deaf: number;
  readonly nudgeMs: number;
}

const flagsOf = (prompt: string): Option.Option<NodeFlags> => {
  const match = /^node:(?<label>[\w-]+)(?<rest>[^\n]*)/u.exec(prompt);

  if (match?.groups === undefined) {
    return Option.none();
  }

  const words = (match.groups.rest ?? "").trim().split(/\s+/u).filter(Boolean);

  const number = (name: string) =>
    Number(
      words
        .find((word) => word.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? 0
    );

  return Option.some({
    label: match.groups.label ?? "",
    flags: new Set(words.filter((word) => !word.includes("="))),
    ms: number("ms"),
    deaf: number("deaf"),
    nudgeMs: number("nudgems"),
  });
};

const textOfUser = (context: ModelContext): string => {
  const first = context.messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

/** The text parts of a tool result. */
export const toolResultText = (message: Message): string =>
  message.role === "toolResult"
    ? message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("")
    : "";

const call = (name: string, args: { [key: string]: JsonValue }, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), {
    stopReason: "toolUse",
  });

/** How a `PLAN` input's model proposes and runs its script. */
type PlanMode = "plan" | "plan-only" | "plan-twice" | "plan-twice-together";

/** Each proposing input's prefix and how its model proposes. */
const PLAN_MODES: ReadonlyArray<readonly [string, PlanMode]> = [
  [PLAN_PREFIX, "plan"],
  [PLAN_ONLY_PREFIX, "plan-only"],
  [PLAN_TWICE_PREFIX, "plan-twice"],
  [PLAN_TWICE_TOGETHER_PREFIX, "plan-twice-together"],
];

/** The launching model's next step when it proposes its script first (`PLAN_PREFIX` and kin). */
const planned = (
  script: string,
  tools: ReadonlyArray<Message>,
  last: Message | undefined,
  mode: PlanMode
): AssistantMessage => {
  const named = (name: string) =>
    tools.filter(
      (message) => message.role === "toolResult" && message.toolName === name
    );

  const plans = named(LAUNCH_TOOL);
  const runs = named(CODEMODE_TOOL_NAME);

  const lastPlan = plans.at(-1);

  const go =
    lastPlan !== undefined && toolResultText(lastPlan).startsWith("Go:");

  const sampled =
    go && toolResultText(lastPlan).includes("run on 1 item first");

  const twice = mode === "plan-twice" || mode === "plan-twice-together";

  if (twice && plans.length === 0) {
    return fauxAssistantMessage(
      TWICE_ARGS.map((args, index) =>
        fauxToolCall(
          LAUNCH_TOOL,
          { script, args },
          { id: `plan-${String(index + 1)}` }
        )
      ),
      { stopReason: "toolUse" }
    );
  }

  if (
    plans.length === 0 ||
    (sampled && runs.length === plans.length && plans.length < 2)
  ) {
    return call(LAUNCH_TOOL, { script }, `plan-${String(plans.length + 1)}`);
  }

  // Every Go, in a two-proposal message, is a run of its own.
  const goes = twice
    ? plans.filter((plan) => toolResultText(plan).startsWith("Go:")).length
    : plans.length;

  // Both Goes run in one tool round, as a model issues the calls after two proposals.
  if (mode === "plan-twice-together" && goes === 2 && runs.length === 0) {
    return fauxAssistantMessage(
      [1, 2].map((n) =>
        fauxToolCall(
          CODEMODE_TOOL_NAME,
          { code: script },
          { id: `run-${String(n)}` }
        )
      ),
      { stopReason: "toolUse" }
    );
  }

  if (mode !== "plan-only" && go && runs.length < goes) {
    return call(
      CODEMODE_TOOL_NAME,
      { code: script },
      `run-${String(runs.length + 1)}`
    );
  }

  return fauxAssistantMessage(
    fauxText(
      `done: ${last === undefined ? "" : toolResultText(last).slice(0, 2000)}`
    )
  );
};

/** The launching model's next step when it runs its script at once (`RUN_PREFIX`). */
const ran = (code: string, last: Message | undefined): AssistantMessage =>
  last?.role === "toolResult"
    ? fauxAssistantMessage(
        fauxText(`done: ${toolResultText(last).slice(0, 2000)}`)
      )
    : call(CODEMODE_TOOL_NAME, { code }, "run-1");

/**
 * A provider error after the work: `fail` always; `limit` and `limitreset` a usage limit until the
 * node's input to go on arrives.
 */
const limitOf = (
  flags: ReadonlySet<string>,
  context: ModelContext
): Option.Option<AssistantMessage> => {
  if (flags.has("fail")) {
    return Option.some(
      fauxAssistantMessage(fauxText(""), {
        stopReason: "error",
        errorMessage: "kit: the provider refused the request",
      })
    );
  }

  const inputs = context.messages.filter(
    (message) => message.role === "user"
  ).length;

  if ((!flags.has("limit") && !flags.has("limitreset")) || inputs !== 1) {
    return Option.none();
  }

  return Option.some(
    fauxAssistantMessage(fauxText(""), {
      stopReason: "error",
      errorMessage: flags.has("limitreset")
        ? "You have hit your ChatGPT usage limit (plus plan). Try again in ~0 min."
        : "GoUsageLimitError: Monthly usage limit reached",
    })
  );
};

/**
 * A proposing thread's next step, when its latest input opens a `PLAN` prefix: it acts on that
 * input and the tool results since, as an earlier run's proposals are that run's.
 */
const proposing = (context: ModelContext): Option.Option<AssistantMessage> => {
  const inputAt = context.messages.findLastIndex(
    (message) => message.role === "user"
  );

  const latest = inputAt === -1 ? undefined : context.messages[inputAt];
  const input = latest === undefined ? "" : messageText(latest);

  const since = context.messages
    .slice(inputAt + 1)
    .filter((message) => message.role === "toolResult");

  return Option.map(
    Option.fromUndefinedOr(
      PLAN_MODES.find(([prefix]) => input.startsWith(prefix))
    ),
    ([prefix, mode]) =>
      planned(input.slice(prefix.length), since, context.messages.at(-1), mode)
  );
};

/** The kit's faux model: what each conversation answers next. */
export const respond = (context: ModelContext): AssistantMessage => {
  const first = textOfUser(context);
  const last = context.messages.at(-1);

  const tools = context.messages.filter(
    (message) => message.role === "toolResult"
  );

  const proposed = proposing(context);

  if (Option.isSome(proposed)) {
    return proposed.value;
  }

  if (first.startsWith(RUN_PREFIX)) {
    return ran(first.slice(RUN_PREFIX.length), last);
  }

  if (first.startsWith("Check one claim")) {
    return tools.length === 0
      ? call(
          RESULT_TOOL_NAME,
          {
            result: { verdict: "verified", reason: "kit" },
            divergence: "None",
          },
          "verify-1"
        )
      : fauxAssistantMessage(fauxText("verified"));
  }

  const node = flagsOf(first);

  if (Option.isNone(node)) {
    return fauxAssistantMessage(fauxText("I am not a node."));
  }

  const { label, flags, ms, deaf, nudgeMs } = node.value;
  const worked = tools.some((message) => message.toolName === WORK_TOOL);

  const submitted = tools.filter(
    (message) => message.toolName === RESULT_TOOL_NAME
  ).length;

  if (!worked) {
    return call(WORK_TOOL, { node: label, ms, deaf }, `work-${label}`);
  }

  const limited = limitOf(flags, context);

  if (Option.isSome(limited)) {
    return limited.value;
  }

  if (flags.has("bad")) {
    return submitted >= 3
      ? fauxAssistantMessage(fauxText("I could not."))
      : call(
          RESULT_TOOL_NAME,
          { result: { wrong: true }, divergence: "None" },
          `bad-${String(submitted)}`
        );
  }

  const nudged = context.messages.some(
    (message) =>
      message.role === "user" &&
      messageText(message).includes("submit_result") &&
      messageText(message) !== first
  );

  const paused = tools.some((message) => message.toolName === PAUSE_TOOL);

  if (flags.has("lazy") && nudged && nudgeMs > 0 && !paused) {
    return call(PAUSE_TOOL, { ms: nudgeMs }, `pause-${label}`);
  }

  if (flags.has("typed") || (flags.has("lazy") && nudged)) {
    return submitted === 0
      ? call(
          RESULT_TOOL_NAME,
          { result: { label }, divergence: "None" },
          `submit-${label}`
        )
      : fauxAssistantMessage(fauxText("submitted"));
  }

  if (flags.has("lazy")) {
    return fauxAssistantMessage(fauxText("I forgot to submit."));
  }

  return fauxAssistantMessage(fauxText(JSON.stringify({ label })));
};

/** The `work` tool: one logged effect per child, then a wait that a stop ends. */
export const workExtension = (options: KitOptions) =>
  defineExtension({
    name: "cairn.test.work",
    tools: [
      defineTool({
        name: WORK_TOOL,
        description: "Do this node's work.",
        parameters: Type.Object({
          node: Type.String(),
          ms: Type.Number(),
          deaf: Type.Number(),
        }),
        callers: ["model"],
        replay: "safe",
        execute: async ({ node, ms, deaf }, api, context) => {
          const started = await api.memo<boolean>("kit.started", context);

          if (started !== true) {
            await api.memo("kit.started", true, context);
            options.effect({ node, what: "start" });
          }

          const signal = context.abortSignal;
          const until = api.now() + ms;

          // Polls the abort signal, as every node tool must; `deaf` keeps ignoring it a while.
          let seen: number | null = null;

          while (api.now() < until) {
            if (signal?.aborted === true) {
              seen ??= api.now();

              if (api.now() - seen >= deaf) {
                options.effect({ node, what: "aborted" });
                signal.throwIfAborted();
              }
            }

            // oxlint-disable-next-line no-await-in-loop
            await sleep(25);
          }

          options.effect({ node, what: "done" });

          return { output: [{ type: "text", text: `worked on ${node}` }] };
        },
      }),
      defineTool({
        name: PAUSE_TOOL,
        description: "Wait a while.",
        parameters: Type.Object({ ms: Type.Number() }),
        callers: ["model"],
        replay: "safe",
        execute: async ({ ms }) => {
          await sleep(ms);

          return { output: [{ type: "text", text: "paused" }] };
        },
      }),
    ],
  });

/** The kit's brain: the Harness, its root thread, and planting and reading helpers. */
export interface KitBrain {
  readonly harness: Harness;
  readonly root: ConversationId;
}

/** What the kit's parts and plants need: the dry run, code mode's sandbox, the result tool. */
export const KitLayer = Layer.mergeAll(
  WorkflowPlan.layer,
  CodeMode.layer,
  ResultTool.layer
);

/** Builds the extensions and the models; the caller opens the Harness over its storage. */
export const kitParts = Effect.fn("WorkflowTestKit.parts")(function* (
  options: KitOptions
) {
  const codemode = yield* CodeMode;
  const results = yield* ResultTool;

  const faux = fauxProvider({
    provider: KIT_MODEL.provider,
    models: [{ id: KIT_MODEL.modelId }, { id: "kit-alt" }],
    tokensPerSecond: options.tokensPerSecond,
  });

  faux.setResponses(Array.from({ length: 5000 }, () => respond));

  const models = createModels();

  models.setProvider(faux.provider);

  const registry = createRegistry();

  registry.install(codemode.extension.extension);
  registry.install(
    workflowExtension({
      resolveModel: kitResolver,
      plan: {
        ...planAccess(
          yield* WorkflowPlan,
          Option.none(),
          fixedDefaultBudget(options.defaultBudget ?? DEFAULT_BUDGET),
          yield* Effect.context()
        ),
        projectRecipe: async (_root, name) =>
          await Promise.resolve(
            Option.fromUndefinedOr(options.projectRecipes?.[name])
          ),
      },
      faults: options.faults,
      hold: options.hold,
      holdRetryMillis: KIT_HOLD_RETRY_MILLIS,
      push: options.push ?? NO_BUDGET_PUSH,
    }).extension
  );
  registry.install(results.extension.extension);
  registry.install(workExtension(options));

  return { models, registry, faux };
});

/**
 * Opens a Harness over `storage` with `parts`, and its root thread. Crashes end no task, as in the
 * brain (`RestartLimit.ts`, ADR 0046), unless `restartLimit` says otherwise.
 */
export const openKit = async (
  storage: Storage,
  parts: Pick<
    Effect.Success<ReturnType<typeof kitParts>>,
    "models" | "registry"
  >,
  context: ChordContext,
  report: (text: string) => void = Function.constVoid,
  restartLimit = Number.POSITIVE_INFINITY
): Promise<KitBrain> => {
  const harness = await DurableHarness.open(
    storage,
    {
      models: parts.models,
      registry: parts.registry,
      settings: { retry: { enabled: false }, restartLimit },
      onReport: (found) => {
        report(`${found.kind}: ${errorText(found.error)}`);
      },
    },
    context
  );

  const root = await harness.root(context, {
    agent: { model: { ...KIT_MODEL }, cwd: KIT_CWD, thinkingLevel: KIT_LEVEL },
  });

  return { harness, root: root.id };
};

/** What a planted launch needs besides its script. */
export interface PlantInput {
  readonly workflowId: string;
  readonly args: Schema.Json;
  readonly budget: Budget;
  readonly sample: Option.Option<number>;
  /** The envelope's node cap; none takes the dry run's count. */
  readonly maxNodes: Option.Option<number>;
  /** The launch approval's status: `accepted` unless a case plants another. */
  readonly status: ApprovalRecord["status"];
  /** Edits the granted envelope before it is frozen (a case that narrows the grant). */
  readonly envelope: (granted: Envelope) => Envelope;
  /**
   * The run the launch is bound to, by its first entry (`LaunchRunsDoc`); none plants it for any
   * run, since a planted launch comes before the run that runs it.
   */
  readonly run: Option.Option<number>;
}

/** The defaults: an accepted launch of the dry run's plan, run on all, from any run. */
export const plantDefaults = (workflowId: string): PlantInput => ({
  workflowId,
  args: {},
  budget: DEFAULT_BUDGET,
  sample: Option.none(),
  maxNodes: Option.none(),
  status: "accepted",
  envelope: (granted) => granted,
  run: Option.none(),
});

// The kit thread runs in the default mode, full access, which the plan grants as `workflow_plan` does.
const MODES: ReadonlyArray<RuntimeMode> = ["full-access"];

/** The launch approval's id for a workflow id. */
export const launchApprovalIdOf = (workflowId: string) =>
  `launch-${workflowId}`;

const encodeLaunch = Schema.encodeSync(WorkflowLaunch);

/**
 * Plants an approved launch of `source` on the kit's root thread, as 5A's answer path will: the
 * dry run's plan frozen in an accepted `brief` record, the row `approved`, and its run binding
 * (`input.run`, any run by default).
 */
export const plant = Effect.fn("WorkflowTestKit.plant")(function* (
  brain: KitBrain,
  source: string,
  input: PlantInput,
  context: ChordContext
) {
  const plan = yield* WorkflowPlan;
  const script = yield* parseWorkflowScript(source);

  const run = yield* plan.dryRun(script, {
    args: input.args,
    budget: input.budget,
    sample: input.sample,
    threadModel: Option.some({
      model: KIT_MODEL,
      thinkingLevel: Option.some(KIT_LEVEL),
    }),
  });

  const launch = toLaunch(run, {
    workflowId: input.workflowId,
    scriptRef: `script-${input.workflowId}`,
    args: input.args,
    budget: input.budget,
    estimate: Option.none(),
    maxNodes: input.maxNodes,
    modes: MODES,
    writes: [],
  });

  const approvalId = launchApprovalIdOf(input.workflowId);

  const payload = plainCopy(
    encodeLaunch({ ...launch, envelope: input.envelope(launch.envelope) })
  );

  yield* Effect.promise(async () => {
    await brain.harness.commit(async (tx) => {
      const approvals = await tx.doc(Approvals, brain.root);
      const ledger = await tx.doc(WorkflowsDoc, brain.root);
      const runs = await tx.doc(LaunchRunsDoc, brain.root);

      runs.items[input.workflowId] = { run: Option.getOrNull(input.run) };
      approvals.items[approvalId] = {
        id: approvalId,
        toolTaskId: 0,
        tool: "workflow_plan",
        kind: "brief",
        summary: `Run workflow ${launch.name}`,
        status: input.status,
        askedAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
        answeredAt: input.status === "pending" ? null : 1,
        run: null,
        executorRequestId: null,
        ...UNDECIDED,
        payload,
        answer:
          input.status === "accepted"
            ? { decision: "accept", answers: null, note: null, launch: null }
            : null,
        decidedBy: input.status === "pending" ? null : { kind: "user" },
      };

      const row = proposedRecord({ launch, approvalId, sample: input.sample });

      approveRecord(row, { kind: "user" }, 1);
      ledger.items[input.workflowId] = row;
    }, context);
  });

  return launch;
});

/** Sends the root thread `RUN:` and `source`, under `requestId`. */
export const runScript = async (
  brain: KitBrain,
  source: string,
  requestId: string,
  context: ChordContext
): Promise<void> => {
  const root = await brain.harness.conversation(brain.root, context);

  await root?.submit(
    { type: "input", content: `${RUN_PREFIX}${source}`, requestId },
    context
  );
};

/** The text of the root thread's last `codemode` result. */
export const codemodeResultText = async (
  brain: KitBrain,
  context: ChordContext
): Promise<string> => {
  const root = await brain.harness.conversation(brain.root, context);
  const view = await root?.context(context);

  const results = (view?.messages ?? []).filter(
    (message) =>
      message.role === "toolResult" && message.toolName === CODEMODE_TOOL_NAME
  );

  const last = results.at(-1);

  return last === undefined ? "" : toolResultText(last);
};

/** Waits `ms`, for holds and pacing in judges and tests. */
export const pause = async (ms: number): Promise<void> => {
  await sleep(ms);
};

/**
 * Runs `reactors` over the kit's event log until the returned function is called, as the reactor
 * host does (`EventReactors.ts`): cursors registered first, then one event per commit. The kit
 * brain has no host of its own; the budget judge's brain runs the real one.
 */
export const driveReactors = async (
  brain: KitBrain,
  reactors: ReadonlyArray<Reactor>,
  context: ChordContext
): Promise<() => Promise<void>> => {
  await brain.harness.commit(async (tx) => {
    await registerCursors(
      tx,
      reactors,
      DateTime.toEpochMillis(DateTime.nowUnsafe())
    );
  }, context);

  const running = { on: true };

  const step = async (target: Reactor) =>
    await brain.harness
      .commit(
        async (tx) =>
          await reactOnce(tx, target, reactorKinds(target), Function.constVoid),
        context
      )
      .catch(() => Option.none());

  const loop = (async () => {
    while (running.on) {
      // oxlint-disable-next-line no-await-in-loop -- one step per reactor, in turn
      const handled = await Promise.all(reactors.map(step));

      if (!handled.some(Option.isSome)) {
        // oxlint-disable-next-line no-await-in-loop
        await sleep(10);
      }
    }
  })();

  return async () => {
    running.on = false;
    await loop;
  };
};

/** One event as the kit reads it back: its name and data. */
export interface KitEvent {
  readonly name: string;
  readonly data: JsonValue;
}

/** The events emitted so far, in log order. */
export const eventsOf = async (
  brain: KitBrain,
  context: ChordContext
): Promise<ReadonlyArray<KitEvent>> =>
  await brain.harness.commit(async (tx) => {
    const state = await tx.doc(EventsDoc);

    if (state.logConversationId === null) {
      return [];
    }

    const read = await tx.scanEntries(
      {
        conversationId: piConversationId(
          StoredConversationId.make(state.logConversationId)
        ),
        order: "ascending",
      },
      5000
    );

    return read.items.flatMap((entry): Array<KitEvent> => {
      const { data } = entry;

      return entry.kind.startsWith(EVENT_KIND_PREFIX) && isEventObject(data)
        ? [
            {
              name: entry.kind.slice(EVENT_KIND_PREFIX.length),
              data: data.data ?? null,
            },
          ]
        : [];
    });
  }, context);
