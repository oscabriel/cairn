// The `results` extension under a real pi-durable Harness over pi-ai's faux provider: the
// provider is sent the child's envelope schema, a rejected call is attempt 1 and a valid second
// call is kept with the run ended on it, a third call is refused even when valid, a nudge before
// any call uses the first attempt, and a thread with no schema is never offered the tool. Kept
// under `brain/`, where pi-durable may be imported in a test (S42).

import type { JsonObject } from "@cairn/protocol/Policy";
import type { JsonValue } from "@earendil-works/chord";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Tool } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import {
  createRegistry,
  defineDoc,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";

import {
  CAP_TEXT,
  NUDGE_TEXT,
  offerResultTool,
  readResult,
  RESULT_TOOL_NAME,
  ResultTool,
  returnedModelOf,
} from "../models/ResultTool.ts";

const context = BACKGROUND_CONTEXT;

/** The probe task's schema: a flat result with an array of objects, a string array and a range. */
const REPORT: JsonObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
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
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string" },
  },
  required: ["summary", "files", "evidence", "confidence"],
  additionalProperties: false,
};

const FILES = [
  { path: "src/a.ts", lines: 40, role: "source" },
  { path: "src/a.test.ts", lines: 12, role: "test" },
];

const EVIDENCE = ["pnpm check passed", "two files read"];

const valid = {
  summary: "Read the module.",
  files: FILES,
  evidence: EVIDENCE,
  confidence: 0.8,
};

const PROVIDER = "faux";

const MODEL = { provider: PROVIDER, modelId: "small" };

/** The writer's view of `cairn.child`, as the spawn will write it: only the schema matters here. */
const ChildForTest = defineDoc<{
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

const call = (args: Record<string, JsonValue>, id: string) =>
  fauxAssistantMessage(fauxToolCall(RESULT_TOOL_NAME, args, { id }), {
    stopReason: "toolUse",
  });

const say = (text: string) => fauxAssistantMessage(text);

const submitText = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === "toolResult" && message.toolName === RESULT_TOOL_NAME
      ? [
          message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join(""),
        ]
      : []
  );

/**
 * Runs a child whose model answers `steps` in turn: with the results extension installed, the
 * tool offered and `schema` in its `cairn.child` (none: no schema and no offer). `inputs` are sent
 * one after another, each waited until idle. Returns the transcript's messages, the stored
 * result, the provider's calls and the tools each request offered.
 */
const runChild = (
  schema: Option.Option<JsonObject>,
  steps: ReadonlyArray<AssistantMessage>,
  inputs: ReadonlyArray<string> = ["Report on the module."]
) =>
  Effect.gen(function* () {
    const offered: Array<ReadonlyArray<Tool>> = [];

    const faux = fauxProvider({
      provider: PROVIDER,
      models: [{ id: "small" }],
    });

    faux.setResponses(
      steps.map((step): FauxResponseStep => (requestContext) => {
        offered.push(getCurrentTools(requestContext.messages));

        return step;
      })
    );

    const models = createModels();

    models.setProvider(faux.provider);

    const results = Context.get(
      yield* Layer.build(ResultTool.layerAt(950)),
      ResultTool
    );

    const registry = createRegistry();

    registry.install(results.extension.extension);

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(new MemoryStorage(), { models, registry }, context)
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    return yield* Effect.promise(async () => {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: Option.isSome(schema)
            ? { model: MODEL, ...offerResultTool }
            : { model: MODEL },
          init: async (tx, id) => {
            if (Option.isSome(schema)) {
              const child = await tx.doc(ChildForTest, id);

              child.resultSchema = copyJson(schema.value);
            }
          },
        },
        context
      );

      // Each input waits for the run before it, so they are sent one after another.
      const send = async (index: number): Promise<void> => {
        const input = inputs[index];

        if (input === undefined) {
          return;
        }

        await conversation.submit(
          { type: "input", content: input, requestId: `r-${String(index)}` },
          context
        );
        await harness.waitForIdle(context);
        await send(index + 1);
      };

      await send(0);

      const view = await conversation.context(context);
      const stored = await readResult(harness, conversation.id, context);

      return {
        messages: view.messages,
        stored,
        calls: faux.state.callCount,
        offered,
      };
    });
  }).pipe(Effect.scoped);

describe("the results extension under a Harness", () => {
  it.live("sends the provider the child's envelope schema", () =>
    Effect.gen(function* () {
      const { offered } = yield* runChild(Option.some(REPORT), [
        call({ result: valid, divergence: "None" }, "c1"),
      ]);

      const tool = offered[0]?.find((each) => each.name === RESULT_TOOL_NAME);

      assert.strictEqual(
        JSON.stringify(tool?.parameters),
        JSON.stringify({
          type: "object",
          properties: {
            result: REPORT,
            divergence: {
              type: "string",
              description:
                'How the work differs from the brief, or "None" when it does not.',
            },
          },
          required: ["result", "divergence"],
          additionalProperties: false,
        })
      );
      assert.deepStrictEqual(tool?.constrainedSampling, {
        type: "json_schema",
        strict: "prefer",
      });
    })
  );

  it.live("keeps a valid second attempt and ends the run on it", () =>
    Effect.gen(function* () {
      const { stored, calls, messages } = yield* runChild(Option.some(REPORT), [
        call({ result: { ...valid, confidence: 3 }, divergence: "None" }, "c1"),
        call(
          {
            result: { ...valid, evidence: JSON.stringify(EVIDENCE) },
            divergence: "None",
          },
          "c2"
        ),
        say("never asked for"),
      ]);

      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(
        Option.map(stored, ({ result, divergence, attempts }) => ({
          result,
          divergence,
          attempts,
        })),
        Option.some({ result: valid, divergence: "None", attempts: 2 })
      );

      const [first] = submitText(messages);

      assert.include(first, "attempt 1 of 2");
      assert.include(first, "result.confidence");
    })
  );

  it.live("refuses a third attempt even when it is valid", () =>
    Effect.gen(function* () {
      const { stored, messages } = yield* runChild(Option.some(REPORT), [
        call({ result: { ...valid, confidence: 3 }, divergence: "None" }, "c1"),
        call({ result: { ...valid, confidence: 4 }, divergence: "None" }, "c2"),
        call({ result: valid, divergence: "None" }, "c3"),
        say("Here is what I found, in plain text."),
      ]);

      assert.isTrue(Option.isNone(stored));

      const texts = submitText(messages);

      assert.strictEqual(texts.length, 3);
      assert.include(texts[1], CAP_TEXT);
      assert.include(texts[2], CAP_TEXT);
    })
  );

  it.live("counts a nudge before any call as the first attempt", () =>
    Effect.gen(function* () {
      const { stored } = yield* runChild(
        Option.some(REPORT),
        [
          say("Done, the module is fine."),
          call({ result: valid, divergence: "None" }, "c1"),
        ],
        ["Report on the module.", NUDGE_TEXT]
      );

      assert.deepStrictEqual(
        Option.map(stored, ({ attempts }) => attempts),
        Option.some(2)
      );
    })
  );

  it.live("never offers the tool to a thread without a schema", () =>
    Effect.gen(function* () {
      const { offered, messages } = yield* runChild(Option.none(), [
        say("hello"),
      ]);

      assert.isFalse(
        offered.flat().some((tool) => tool.name === RESULT_TOOL_NAME)
      );
      assert.deepStrictEqual(
        Option.map(returnedModelOf(messages), (model) => model.modelId),
        Option.some("small")
      );
    })
  );
});
