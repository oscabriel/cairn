// The typed-results trials behind `judges/typed-results.ts` (J-typed) and how each is judged. The
// task, its schema and the verdict live here; the two ways a trial runs are:
//
// - through real subagent children (`TypedChildren.ts`, the judge's default): a parent spawns a
//   typed brief, the judge says Go, and 3A's reporter sends the nudge;
// - through a bare pi-durable Harness with Cairn's real `results` extension (`runTrials` here):
//   one child conversation per trial with the probe task's schema in its `cairn.child` and
//   `submit_result` offered, the nudge sent once by this file when a child ends without a result.
//   The v1 control always runs this way, since it replaces the result tool.
//
// Every trial is judged from outside the tool (`judgeTrial`): the stored result decoded against a
// schema written here (not the tool's), attempts counted here from the transcript's messages and
// compared with the count the tool stored, and the returned model compared with the requested and
// dispatched ones. A trial is valid on those alone; whether the result holds the task's facts is
// reported beside it and never fails the judge (wave 2 decision, `docs/phase-2/waves.md`).
//
// Two controls run the same task and must fail: the v1 tool (an open object, the schema in the
// prompt, no repair: 0 of 8 valid on OpenCode Go in the models note's probe), and a schema whose
// root is a union, which the result tool refuses at brief time.
//
// pi-durable and pi-ai are imported here, under `judges/fixtures/` (S42).

import { Claude } from "@cairn/bridge/Claude";
import type { ModelRef } from "@cairn/protocol/Models";
import type { JsonObject } from "@cairn/protocol/Policy";
import { copyJson } from "@earendil-works/chord";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { AgentChange, Extension } from "@earendil-works/pi-durable";
import {
  createRegistry,
  defineDoc,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Result,
  Schema,
} from "effect";

import { BridgeCwd } from "../../apps/server/src/brain/BridgeCwdExtension.ts";
import {
  checkResultSchema,
  MAX_RESULT_ATTEMPTS,
  NUDGE_TEXT,
  nudgeDue,
  offerResultTool,
  readAttemptState,
  readResult,
  RESULT_TOOL_NAME,
  ResultDoc,
  ResultTool,
  returnedModelOf,
} from "../../apps/server/src/models/ResultTool.ts";
import type {
  AttemptState,
  ResultState,
} from "../../apps/server/src/models/ResultTool.ts";

const context = BACKGROUND_CONTEXT;

/** The probe task's result schema, as a brief would name it. */
export const REPORT_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One sentence on what you found." },
    files: {
      type: "array",
      description: "Every file you were told about, in the order given.",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          lines: { type: "integer", minimum: 1 },
          role: { type: "string", enum: ["source", "test", "doc"] },
        },
        required: ["path", "lines", "role"],
        additionalProperties: false,
      },
    },
    evidence: {
      type: "array",
      description: "Short statements supporting the summary, at least two.",
      items: { type: "string" },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["summary", "files", "evidence", "confidence"],
  additionalProperties: false,
};

/** A schema whose root is a union: the second control. */
export const UNION_SCHEMA: JsonObject = {
  anyOf: [REPORT_SCHEMA, { type: "string" }],
};

const FILES = [
  { path: "src/parse.ts", lines: 120, role: "source" },
  { path: "src/parse.test.ts", lines: 64, role: "test" },
  { path: "README.md", lines: 30, role: "doc" },
] as const;

/** The probe task: the bare child's first input, and the brief a parent spawns with. */
export const TASK = [
  "You reviewed a small repository. Its files are:",
  ...FILES.map(
    (file) => `- ${file.path}: ${String(file.lines)} lines, ${file.role}`
  ),
  "The tests cover the happy path of parse() but not empty input, and the README documents parse() only.",
  "Report what you found: a one-sentence summary, every file with its path, line count and role, at least two pieces of evidence, and your confidence from 0 to 1.",
  `End by calling ${RESULT_TOOL_NAME}.`,
].join("\n");

/** The v1 prompt: the same task with the schema written out, as v1 did. */
const V1_TASK = `${TASK}\nThe result must match this JSON Schema:\n${JSON.stringify(REPORT_SCHEMA)}`;

/** The probe's result as the judge decodes it, independently of the tool. */
const Report = Schema.Struct({
  summary: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      lines: Schema.Int,
      role: Schema.Literals(["source", "test", "doc"]),
    })
  ),
  evidence: Schema.Array(Schema.String),
  confidence: Schema.Finite,
});

const decodeReport = Schema.decodeUnknownOption(Report);

const decodeWrapped = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String))
);

/**
 * Why `value` is not a valid result, or `""` when it is: it decodes against the judge's schema,
 * and no `evidence` item is a whole array sent as a JSON string, the measured v1 fault the schema
 * alone lets through.
 */
export const schemaFailure = (value: JsonValue): string =>
  Option.match(decodeReport(value), {
    onNone: () => "schema",
    onSome: (report) =>
      report.evidence.some((line) => Option.isSome(decodeWrapped(line)))
        ? `evidence wrapped ${JSON.stringify(report.evidence)}`
        : "",
  });

/**
 * Which of the task's facts a result gets wrong, or `""` when it holds them all: every file in
 * order with its line count and role, at least two pieces of evidence, a confidence in range.
 */
export const factsFailure = (value: JsonValue): string =>
  Option.match(decodeReport(value), {
    onNone: () => "schema",
    onSome: (report) => {
      if (
        report.files.length !== FILES.length ||
        !FILES.every(
          (file, index) =>
            report.files[index]?.path === file.path &&
            report.files[index]?.lines === file.lines &&
            report.files[index]?.role === file.role
        )
      ) {
        return `files ${JSON.stringify(report.files)}`;
      }

      if (report.evidence.length < 2) {
        return `evidence ${JSON.stringify(report.evidence)}`;
      }

      return report.confidence >= 0 && report.confidence <= 1
        ? ""
        : `confidence ${String(report.confidence)}`;
    },
  });

/** How a trial's child is set up: Cairn's result tool, or the v1 control. */
export type TrialMode = "typed" | "v1";

/** One trial's verdict. */
export interface Trial {
  /** The gate: a schema-valid result within two attempts, counted alike, from the right model. */
  readonly valid: boolean;
  readonly stored: boolean;
  readonly schemaValid: boolean;
  /** Why the stored result is not valid, when it is not: `schemaFailure`, or "none stored". */
  readonly failure: string;
  /** Reported apart: the result holds every fact the task gave. */
  readonly factsRight: boolean;
  /** Which fact is wrong, when one is. */
  readonly factsFailure: string;
  /** Attempts counted by the judge from the transcript. */
  readonly attempts: number;
  /** The count the tool stored with the result; 0 when none was stored. */
  readonly storedAttempts: number;
  readonly nudged: boolean;
  readonly returnedModel: string;
  readonly dispatchedModel: string;
  /** The returned and dispatched models are both the one the trial asked for. */
  readonly modelMatches: boolean;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly error: string;
  /** Each rejected `submit_result` call's first line, in order: why an attempt was spent. */
  readonly rejections: ReadonlyArray<string>;
}

/** What a trial left behind, read once its child settled. */
export interface TrialReading {
  /** The child's messages, oldest first. */
  readonly messages: ReadonlyArray<Message>;
  /** The child's `cairn.result`, when one was accepted. */
  readonly stored: Option.Option<ResultState>;
  /** The model the trial asked for. */
  readonly requested: ModelRef;
  /** The model the child was dispatched on: its dispatch record's, or the requested one when bare. */
  readonly dispatched: Option.Option<ModelRef>;
}

const usageOf = (messages: ReadonlyArray<Message>) => {
  const sum = { cost: 0, input: 0, output: 0 };

  for (const message of messages) {
    if (message.role === "assistant") {
      sum.cost += message.usage.cost.total;
      sum.input +=
        message.usage.input +
        message.usage.cacheRead +
        message.usage.cacheWrite;
      sum.output += message.usage.output;
    }
  }

  return sum;
};

const textOf = (message: Message): string => {
  if (message.role === "assistant") {
    return "";
  }

  return Predicate.isString(message.content)
    ? message.content
    : message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
};

const isNudge = (message: Message) =>
  message.role === "user" && textOf(message).trim() === NUDGE_TEXT;

/**
 * The attempts a child used, counted from its messages without the tool's own reading: each
 * `submit_result` result up to and including the first that is not an error, and the nudge when
 * it came before any such result.
 */
export const attemptsOf = (messages: ReadonlyArray<Message>) => {
  let calls = 0;
  let nudgedFirst = false;

  for (const message of messages) {
    if (isNudge(message) && calls === 0) {
      nudgedFirst = true;
    }

    if (
      message.role === "toolResult" &&
      message.toolName === RESULT_TOOL_NAME
    ) {
      calls += 1;

      if (!message.isError) {
        break;
      }
    }
  }

  return calls + (nudgedFirst ? 1 : 0);
};

const rejectionsOf = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === "toolResult" &&
    message.toolName === RESULT_TOOL_NAME &&
    message.isError
      ? [textOf(message).slice(0, 240)]
      : []
  );

const errorOf = (messages: ReadonlyArray<Message>) => {
  const last = messages.findLast((message) => message.role === "assistant");

  return last?.role === "assistant" && last.stopReason === "error"
    ? (last.errorMessage ?? "error")
    : "";
};

const refOf = (model: Option.Option<ModelRef>) =>
  Option.match(model, {
    onNone: () => "none",
    onSome: (found) => `${found.provider}/${found.modelId}`,
  });

const sameModel = (model: Option.Option<ModelRef>, wanted: ModelRef) =>
  Option.exists(
    model,
    (found) =>
      found.provider === wanted.provider && found.modelId === wanted.modelId
  );

/** A trial's verdict from what it left behind. */
export const judgeTrial = (reading: TrialReading): Trial => {
  const { messages, stored, requested } = reading;
  const returned = returnedModelOf(messages);
  const usage = usageOf(messages);

  const failure = Option.match(stored, {
    onNone: () => "none stored",
    onSome: (value) => schemaFailure(value.result),
  });

  const facts = Option.match(stored, {
    onNone: () => "none stored",
    onSome: (value) => factsFailure(value.result),
  });

  const attempts = attemptsOf(messages);

  const storedAttempts = Option.match(stored, {
    onNone: () => 0,
    onSome: (value) => value.attempts,
  });

  const modelMatches =
    sameModel(returned, requested) && sameModel(reading.dispatched, requested);

  const schemaValid = failure === "";

  return {
    valid:
      schemaValid &&
      attempts >= 1 &&
      attempts <= MAX_RESULT_ATTEMPTS &&
      storedAttempts === attempts &&
      modelMatches,
    stored: Option.isSome(stored),
    schemaValid,
    failure,
    factsRight: facts === "",
    factsFailure: facts,
    attempts,
    storedAttempts,
    nudged: messages.some(isNudge),
    returnedModel: refOf(returned),
    dispatchedModel: refOf(reading.dispatched),
    modelMatches,
    costUsd: usage.cost,
    inputTokens: usage.input,
    outputTokens: usage.output,
    error: errorOf(messages),
    rejections: rejectionsOf(messages),
  };
};

const decodeV1 = Schema.decodeUnknownSync(
  Schema.Struct({ result: Schema.Json, divergence: Schema.String })
);

/** The v1 tool: an open object, validated against the schema in `execute` with no repair. */
const v1Tool = defineTool({
  name: RESULT_TOOL_NAME,
  description:
    "Submit your final result. Arguments: result (matching the schema in the prompt) and divergence.",
  parameters: Type.Unsafe<JsonObject>({
    type: "object",
    additionalProperties: true,
  }),
  replay: "safe",
  execute: async (args, api, invocation) => {
    const checked = Result.try({
      try: () =>
        decodeV1(
          validateToolArguments(
            {
              name: RESULT_TOOL_NAME,
              description: "",
              parameters: Type.Unsafe({
                type: "object",
                properties: {
                  result: REPORT_SCHEMA,
                  divergence: { type: "string" },
                },
                required: ["result", "divergence"],
              }),
            },
            {
              type: "toolCall",
              id: api.callId,
              name: RESULT_TOOL_NAME,
              arguments: args,
            }
          )
        ),
      catch: (error) => (Predicate.isError(error) ? error.message : "invalid"),
    });

    if (Result.isFailure(checked)) {
      return {
        output: [{ type: "text", text: checked.failure }],
        isError: true,
      };
    }

    const { result, divergence } = checked.success;

    await api.commit(async (tx) => {
      const document = await tx.doc(ResultDoc, api.conversationId);

      if (document.attempts === 0) {
        document.result = copyJson(result);
        document.divergence = divergence;
        document.attempts = 1;
      }
    }, invocation);

    return {
      output: [{ type: "text", text: "Result accepted." }],
      control: { terminate: true },
    };
  },
});

const v1Extension = defineExtension({
  name: "cairn.judge.v1-result",
  tools: [v1Tool],
});

/** The spawn's view of `cairn.child`: only the schema is read by the result tool. */
const ChildForJudge = defineDoc<{
  [key: string]: JsonValue;
  resultSchema: JsonValue;
}>({
  kind: "cairn.child",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ resultSchema: null }),
  checkpointWhen: () => false,
});

/** The `results` extension at the order key the brain gives it. */
const typedExtension = Effect.map(
  Layer.build(ResultTool.layer),
  (built) => Context.get(built, ResultTool).extension.extension
);

/** What one model's bare run needs: its models, the dispatched ref, and extra extensions. */
export interface Target {
  readonly models: Models;
  readonly model: ModelRef;
  readonly cwd: Option.Option<string>;
  readonly extensions: ReadonlyArray<Extension>;
}

/**
 * Runs `trials` bare children of `mode` on `target` at once, each through its task and at most one
 * nudge, and judges each.
 */
export const runTrials = (target: Target, mode: TrialMode, trials: number) =>
  Effect.gen(function* () {
    const results = mode === "typed" ? yield* typedExtension : v1Extension;

    const registry = createRegistry();

    for (const extension of [...target.extensions, results]) {
      registry.install(extension);
    }

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(
            new MemoryStorage(),
            { models: target.models, registry },
            context
          )
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    const base: AgentChange =
      mode === "typed"
        ? { model: target.model, ...offerResultTool }
        : { model: target.model };

    const agent: AgentChange = Option.match(target.cwd, {
      onNone: () => base,
      onSome: (cwd) => ({ ...base, cwd }),
    });

    const one = async (index: number): Promise<Trial> => {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent,
          init: async (tx, id) => {
            if (mode === "typed") {
              const child = await tx.doc(ChildForJudge, id);

              child.resultSchema = copyJson(REPORT_SCHEMA);
            }
          },
        },
        context
      );

      const stateOf = async (): Promise<AttemptState> =>
        await conversation.commit(
          async (tx) => await readAttemptState(tx, conversation.id),
          context
        );

      await conversation.submit(
        {
          type: "input",
          content: mode === "typed" ? TASK : V1_TASK,
          requestId: `task-${String(index)}`,
        },
        context
      );
      await conversation.waitForIdle(context);

      // The delegating side's one nudge, as the subagent reporter sends it.
      if (nudgeDue(await stateOf())) {
        await conversation.submit(
          {
            type: "input",
            content: NUDGE_TEXT,
            requestId: `nudge-${String(index)}`,
          },
          context
        );
        await conversation.waitForIdle(context);
      }

      const stored = await readResult(harness, conversation.id, context);
      const { messages } = await conversation.context(context);

      return judgeTrial({
        messages,
        stored,
        requested: target.model,
        dispatched: Option.some(target.model),
      });
    };

    return yield* Effect.promise(
      async () =>
        await Promise.all(
          Array.from({ length: trials }, async (_, index) => await one(index))
        )
    );
  }).pipe(Effect.scoped);

/** The union control: whether the result tool refuses the schema at brief time, and why. */
export const unionControl = () => {
  const checked = checkResultSchema(UNION_SCHEMA);

  return Result.isFailure(checked)
    ? { refused: true, reason: checked.failure.reason }
    : { refused: false, reason: "accepted" };
};

/** A bare `Target` on the bridge: Claude's provider alone, with Cairn's `bridge-cwd` extension. */
export const bridgeTarget = (modelId: string, cwd: string) =>
  Effect.gen(function* () {
    const claude = yield* Claude;
    const bridgeCwd = yield* BridgeCwd;
    const models = createModels();

    models.setProvider(claude.provider);

    const target: Target = {
      models,
      model: { provider: "claude-bridge", modelId },
      cwd: Option.some(cwd),
      extensions: [bridgeCwd.extension.extension],
    };

    return target;
  });
