// The `cairn.budgets` gate under a real pi-durable Harness over pi-ai's faux provider, with the
// book holding scopes as the guard would leave them:
//
// - a `stop` scope at its line blocks the next tool call with the refusal text, and lets
//   `submit_result` through, so a typed child can still hand in what it has;
// - a `drain` scope at its line lets ordinary tools run and blocks `subagent_spawn`;
// - a thread below every line is blocked from `subagent_send` to a child whose own scope stopped,
//   and may send to a child below its line;
// - a scope below its line blocks nothing.
//
// The tools are stand-ins under the real names (the gate reads the name and the `subagent`
// argument only). Kept under `brain/`, where pi-durable may be imported in a test (S42).

import type { ThreadId } from "@cairn/protocol/Ids";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { testThreadId } from "../shell/ShellTestKit.ts";
import { BudgetBook } from "../usage/BudgetBook.ts";
import type { BudgetMode } from "../usage/BudgetBook.ts";
import { standingOf } from "../usage/Budgets.ts";
import { tokenBudget } from "../usage/BudgetTestKit.ts";
import { BudgetGate } from "./BudgetGateExtension.ts";
import { ThreadMeta } from "./CairnDocs.ts";

const context = BACKGROUND_CONTEXT;

const PROVIDER = "faux";

const MODEL = { provider: PROVIDER, modelId: "small" };

const HEAD = testThreadId(1);

const CHILD = testThreadId(2);

const OTHER = testThreadId(3);

const RAN = "ran";

/** Every tool the gate decides on, each answering `ran`. */
const standIns = defineExtension({
  name: "cairn.test.budget-stand-ins",
  tools: ["noop", "submit_result", "subagent_spawn", "subagent_send"].map(
    (name) =>
      defineTool({
        name,
        description: `Stands in for ${name}.`,
        parameters: Type.Unsafe<Record<string, JsonValue>>({ type: "object" }),
        replay: "safe",
        execute: async () =>
          await Promise.resolve({
            output: [{ type: "text" as const, text: RAN }],
          }),
      })
  ),
});

const call = (tool: string, id: string, args: Record<string, JsonValue> = {}) =>
  fauxAssistantMessage(fauxToolCall(tool, args, { id }), {
    stopReason: "toolUse",
  });

/** Each tool result's id and text, in order. */
const resultsOf = (messages: ReadonlyArray<Message>) =>
  messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          [
            message.toolCallId,
            message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          ] as const,
        ]
      : []
  );

/** A scope on `threadId` with a 100-token budget in `mode`, standing at `spent` tokens. */
const scope = (threadId: ThreadId, mode: BudgetMode, spent: number) =>
  Effect.gen(function* () {
    const book = yield* BudgetBook;
    const budget = tokenBudget(100);

    yield* book.set({ threadId, budget, mode, epoch: 0 });
    yield* book.stand(
      threadId,
      standingOf(budget, { tokens: spent, listMicros: 0, unpricedTokens: 0 })
    );
  });

/** Runs `HEAD` through `steps` with the gate installed; returns its tool results. */
const runHead = (steps: ReadonlyArray<AssistantMessage>) =>
  Effect.gen(function* () {
    const gate = yield* BudgetGate;
    const book = yield* BudgetBook;

    yield* book.setParents(
      new Map([
        [CHILD, HEAD],
        [OTHER, HEAD],
      ])
    );

    const faux = fauxProvider({
      provider: PROVIDER,
      models: [{ id: "small" }],
    });

    faux.setResponses([...steps, fauxAssistantMessage("done")]);

    const models = createModels();

    models.setProvider(faux.provider);

    const registry = createRegistry();

    registry.install(gate.extension.extension);
    registry.install(standIns);

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
          agent: { model: MODEL },
          init: async (tx, id) => {
            const meta = await tx.doc(ThreadMeta, id);

            meta.threadId = HEAD;
          },
        },
        context
      );

      await conversation.submit(
        { type: "input", content: "Work.", requestId: "r-1" },
        context
      );
      await harness.waitForIdle(context);

      const view = await conversation.context(context);

      return new Map(resultsOf(view.messages));
    });
  });

const World = BudgetGate.layer.pipe(Layer.provideMerge(BudgetBook.layer));

const blocked = (text: string | undefined) =>
  (text ?? "").includes(`Budget reached for thread ${HEAD}`);

describe("the budgets gate under a Harness", () => {
  it.live(
    "a stop scope at its line blocks the next tool call and lets submit_result through",
    () =>
      Effect.gen(function* () {
        yield* scope(HEAD, "stop", 120);

        const results = yield* runHead([
          call("noop", "c1"),
          call("submit_result", "c2"),
        ]);

        assert.isTrue(blocked(results.get("c1")), results.get("c1"));
        assert.include(results.get("c1") ?? "", "submit_result");
        assert.strictEqual(results.get("c2"), RAN);
      }).pipe(Effect.scoped, Effect.provide(World))
  );

  it.live(
    "a drain scope at its line runs ordinary tools and blocks subagent_spawn",
    () =>
      Effect.gen(function* () {
        yield* scope(HEAD, "drain", 120);

        const results = yield* runHead([
          call("noop", "c1"),
          call("subagent_spawn", "c2", { title: "More" }),
        ]);

        assert.strictEqual(results.get("c1"), RAN);
        assert.isTrue(blocked(results.get("c2")), results.get("c2"));
        assert.include(results.get("c2") ?? "", "no new subagent work starts");
      }).pipe(Effect.scoped, Effect.provide(World))
  );

  it.live(
    "blocks subagent_send to a stopped child, and lets one to a child below its line through",
    () =>
      Effect.gen(function* () {
        yield* scope(CHILD, "stop", 150);
        yield* scope(OTHER, "stop", 10);

        const results = yield* runHead([
          call("subagent_send", "c1", { subagent: CHILD, text: "More." }),
          call("subagent_send", "c2", { subagent: OTHER, text: "More." }),
          call("noop", "c3"),
        ]);

        assert.include(
          results.get("c1") ?? "",
          `Budget reached for thread ${CHILD}`
        );
        assert.strictEqual(results.get("c2"), RAN);
        assert.strictEqual(results.get("c3"), RAN);
      }).pipe(Effect.scoped, Effect.provide(World))
  );

  it.live("a scope below its line blocks nothing", () =>
    Effect.gen(function* () {
      yield* scope(HEAD, "stop", 50);

      const results = yield* runHead([
        call("noop", "c1"),
        call("subagent_spawn", "c2", { title: "More" }),
      ]);

      assert.deepStrictEqual([...results.values()], [RAN, RAN]);
    }).pipe(Effect.scoped, Effect.provide(World))
  );
});
