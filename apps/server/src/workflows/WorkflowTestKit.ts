// A workflow brain for tests and the workflow judges: a real pi-durable Harness with Cairn's code
// mode extension (its `WaitingSandbox` and slot pools), the workflows extension and its gate, and
// the results extension, over pi-ai's faux provider. Never the deployed brain.
//
// The faux model plays every part from what it is sent:
//
// - The launching thread's model is sent `RUN:` and a script; it calls `codemode` with that script
//   once, then answers `done` with the tool's result.
// - A node's child is sent a prompt that opens `node:<label>` with flags: it first calls the judge's
//   `work` tool (one effect, logged once per child, `ms=` long, deaf to an abort for `deaf=` ms),
//   then answers. `typed` answers with `submit_result`, `lazy` ends without it the first time (so
//   the nudge is due), `bad` submits an invalid value every time, `fail` ends its run with a
//   provider error, `text` (the default) answers `{"label":...}` as text.
// - A `verify` node's child (its prompt opens "Check one claim") submits `verified`.
//
// Launches are planted the way 5A's answer path will write them: the script is parsed and
// dry-run (`WorkflowPlan`), its launch payload frozen in an accepted `brief` approval record, and an
// `approved` row written beside it, in one host commit.

import { setTimeout as sleep } from "node:timers/promises";

import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { Envelope, RuntimeMode } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import type { JsonValue } from "@earendil-works/chord";
import type { Context as ChordContext } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Message,
  Context as ModelContext,
} from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
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
import { Effect, Function, Layer, Option, Result, Schema } from "effect";

import { Approvals, UNDECIDED } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { CodeMode } from "../brain/CodeMode.ts";
import { messageText } from "../brain/CommitFeed.ts";
import { RESULT_TOOL_NAME, ResultTool } from "../models/ResultTool.ts";
import { jsonRecordOf } from "../subagents/SubagentDocs.ts";
import { approveRecord, proposedRecord, WorkflowsDoc } from "./WorkflowDocs.ts";
import { toLaunch, WorkflowPlan } from "./WorkflowPlan.ts";
import { parseWorkflowScript } from "./WorkflowScript.ts";
import { workflowExtension } from "./WorkflowTools.ts";
import type {
  HoldPoint,
  RoleResolver,
  WorkflowFaultSet,
} from "./WorkflowTools.ts";

/** The faux provider and model every conversation of the kit runs on. */
export const KIT_MODEL = { provider: "faux", modelId: "kit" } as const;

/** A spec the kit's resolver cannot resolve. */
export const UNRESOLVABLE_ROLE = "@nobody";

/** What opens a launching thread's input: the script to run follows. */
export const RUN_PREFIX = "RUN:\n";

/** The judge tool every node's child calls first. */
export const WORK_TOOL = "work";

/** Resolves every spec to the kit's model, except `UNRESOLVABLE_ROLE`. */
export const kitResolver: RoleResolver = async (spec) =>
  await Promise.resolve(
    spec === UNRESOLVABLE_ROLE
      ? Result.fail(`no model is bound to ${spec}`)
      : Result.succeed({
          provider: KIT_MODEL.provider,
          modelId: KIT_MODEL.modelId,
          thinkingLevel: Option.none(),
        })
  );

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
}

/** The flags of a node prompt: `node:<label> typed ms=200`. */
interface NodeFlags {
  readonly label: string;
  readonly flags: ReadonlySet<string>;
  readonly ms: number;
  readonly deaf: number;
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

/** The kit's faux model: what each conversation answers next. */
export const respond = (context: ModelContext): AssistantMessage => {
  const first = textOfUser(context);
  const last = context.messages.at(-1);

  const tools = context.messages.filter(
    (message) => message.role === "toolResult"
  );

  if (first.startsWith(RUN_PREFIX)) {
    return last?.role === "toolResult"
      ? fauxAssistantMessage(
          fauxText(`done: ${toolResultText(last).slice(0, 2000)}`)
        )
      : call(
          CODEMODE_TOOL_NAME,
          { code: first.slice(RUN_PREFIX.length) },
          "run-1"
        );
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

  const { label, flags, ms, deaf } = node.value;
  const worked = tools.some((message) => message.toolName === WORK_TOOL);

  const submitted = tools.filter(
    (message) => message.toolName === RESULT_TOOL_NAME
  ).length;

  if (!worked) {
    return call(WORK_TOOL, { node: label, ms, deaf }, `work-${label}`);
  }

  if (flags.has("fail")) {
    return fauxAssistantMessage(fauxText(""), {
      stopReason: "error",
      errorMessage: "kit: the provider refused the request",
    });
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
const workExtension = (options: KitOptions) =>
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
    models: [{ id: KIT_MODEL.modelId }],
    tokensPerSecond: options.tokensPerSecond,
  });

  faux.setResponses(Array.from({ length: 5000 }, () => respond));

  const models = createModels();

  models.setProvider(faux.provider);

  const registry = createRegistry();

  registry.install(codemode.extension.extension);
  registry.install(
    workflowExtension({
      resolveRole: kitResolver,
      faults: options.faults,
      hold: options.hold,
    }).extension
  );
  registry.install(results.extension.extension);
  registry.install(workExtension(options));

  return { models, registry, faux };
});

/** Opens a Harness over `storage` with `parts`, and its root thread. */
export const openKit = async (
  storage: Storage,
  parts: Pick<
    Effect.Success<ReturnType<typeof kitParts>>,
    "models" | "registry"
  >,
  context: ChordContext,
  report: (text: string) => void = Function.constVoid
): Promise<KitBrain> => {
  const harness = await DurableHarness.open(
    storage,
    {
      models: parts.models,
      registry: parts.registry,
      settings: { retry: { enabled: false } },
      onReport: (error) => {
        report(String(error));
      },
    },
    context
  );

  const root = await harness.root(context, {
    agent: { model: { ...KIT_MODEL } },
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
}

/** The defaults: an accepted launch of the dry run's plan, run on all. */
export const plantDefaults = (workflowId: string): PlantInput => ({
  workflowId,
  args: {},
  budget: DEFAULT_BUDGET,
  sample: Option.none(),
  maxNodes: Option.none(),
  status: "accepted",
  envelope: (granted) => granted,
});

const MODES: ReadonlyArray<RuntimeMode> = ["approval-required"];

/** The launch approval's id for a workflow id. */
export const launchApprovalIdOf = (workflowId: string) =>
  `launch-${workflowId}`;

const encodeLaunch = Schema.encodeSync(WorkflowLaunch);

/**
 * Plants an approved launch of `source` on the kit's root thread, as 5A's answer path will: the
 * dry run's plan frozen in an accepted `brief` record, and the row `approved`.
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
  });

  const launch = toLaunch(run, {
    workflowId: input.workflowId,
    scriptRef: `script-${input.workflowId}`,
    args: input.args,
    budget: input.budget,
    estimate: Option.none(),
    roleOverrides: {},
    maxNodes: input.maxNodes,
    modes: MODES,
    writes: [],
  });

  const approvalId = launchApprovalIdOf(input.workflowId);

  const payload = jsonRecordOf(
    encodeLaunch({ ...launch, envelope: input.envelope(launch.envelope) })
  );

  yield* Effect.promise(async () => {
    await brain.harness.commit(async (tx) => {
      const approvals = await tx.doc(Approvals, brain.root);
      const ledger = await tx.doc(WorkflowsDoc, brain.root);

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
