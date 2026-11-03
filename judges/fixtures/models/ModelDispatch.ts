// J-models (ADR 0043), on a real pi-durable Harness over pi-ai's faux providers and a migrated
// in-memory `cairn.sqlite`.
//
// A parent runs on `alpha/a1` at `high`. Child A is dispatched naming no model: the dispatching
// commit configures it with its parent's model and level, read from the parent's `pi.agent`, as the
// subagent start task does. Child B is dispatched naming `beta/b1`: `ModelSpecs.resolve` checks it
// and the commit configures it with that model; child B calls the `models` tool and answers. A
// third dispatch names `beta/b9`, which beta's catalog lacks: it is refused with the reason and
// creates nothing. What the scenario reports: each child's `pi.agent`, which provider served each
// request, the refusal, and what the `models` tool told child B, once short and once searched.
//
// `inherit` decides what a child that names no model takes from its parent: `parent` is Cairn's
// rule (the parent's model and level); `model-only` is the broken control, a dispatch that drops
// the parent's level, which `verdictOf` must catch.

import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ConversationId } from "@earendil-works/pi-durable";
import {
  AgentDoc,
  configure,
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Option } from "effect";

import { ExtensionOrder } from "../../../apps/server/src/brain/Extensions.ts";
import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import { ModelHealth } from "../../../apps/server/src/models/ModelHealth.ts";
import { ModelsTool } from "../../../apps/server/src/models/ModelsExtension.ts";
import { ModelSpecs } from "../../../apps/server/src/models/ModelSpecs.ts";
import { PiModelSource } from "../../../apps/server/src/models/PiModelSource.ts";
import { SettingsStore } from "../../../apps/server/src/models/SettingsStore.ts";

const context = BACKGROUND_CONTEXT;

/** The model and level the parent runs on. */
export const PARENT: ModelRef = { provider: "alpha", modelId: "a1" };

/** The parent's thinking level. */
export const PARENT_LEVEL: ThinkingLevel = "high";

/** The model child B names. */
export const NAMED: ModelRef = { provider: "beta", modelId: "b1" };

/** A model beta's catalog lacks, which a dispatch must refuse. */
export const MISSING_SPEC = "beta/b9";

/** What a child that names no model takes from its parent. */
export type Inherit = "parent" | "model-only";

/** One child as the scenario saw it after everything ran. */
export interface ChildReport {
  readonly model: Option.Option<ModelRef>;
  readonly thinkingLevel: Option.Option<string>;
}

/** What the scenario observed. */
export interface ScenarioReport {
  readonly a: ChildReport;
  readonly b: ChildReport;
  /** Requests each faux provider served: the parent's none, child A once, child B three times. */
  readonly calls: { readonly alpha: number; readonly beta: number };
  /** Why the dispatch naming `MISSING_SPEC` was refused; none when it was not. */
  readonly refused: Option.Option<string>;
  /** The `models` tool's text as child B's model received it. */
  readonly modelsToolText: string;
  /** Its text for child B's second call, which searched for the parent's provider. */
  readonly searchedText: string;
}

const sameModel = (a: ModelRef, b: ModelRef) =>
  a.provider === b.provider && a.modelId === b.modelId;

const text = (model: ModelRef) => `${model.provider}/${model.modelId}`;

/** A model the report may lack, as text. */
const modelText = (model: Option.Option<ModelRef>) =>
  Option.match(model, { onNone: () => "nothing", onSome: text });

/** The text of the newest tool result in a request's transcript. */
const lastToolResultText = (transcript: TranscriptContext): string => {
  const results = transcript.messages.filter(
    (message) => message.role === "toolResult"
  );

  const last = results.at(-1);

  return last === undefined
    ? ""
    : last.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
};

/** Runs the scenario with children that name no model taking `inherit` from their parent. */
export const runScenario = (inherit: Inherit) =>
  Effect.gen(function* () {
    const alpha = fauxProvider({
      api: "faux-alpha",
      provider: PARENT.provider,
      models: [{ id: PARENT.modelId, reasoning: true }],
    });

    const beta = fauxProvider({
      api: "faux-beta",
      provider: NAMED.provider,
      models: [{ id: NAMED.modelId, reasoning: true }],
    });

    let modelsToolText = "";
    let searchedText = "";

    alpha.setResponses([fauxAssistantMessage("child A, answer")]);

    beta.setResponses([
      fauxAssistantMessage([fauxToolCall("models", {})], {
        stopReason: "toolUse",
      }),
      (transcript) => {
        modelsToolText = lastToolResultText(transcript);

        return fauxAssistantMessage(
          [fauxToolCall("models", { search: PARENT.provider })],
          { stopReason: "toolUse" }
        );
      },
      (transcript) => {
        searchedText = lastToolResultText(transcript);

        return fauxAssistantMessage("child B, answer");
      },
    ]);

    const models = createModels();

    models.setProvider(alpha.provider);
    models.setProvider(beta.provider);

    const source = Layer.mock(ModelSource)({
      models: () => models,
      settings: () => ({}),
    });

    const services = yield* Layer.build(
      ModelsTool.layerAt(ExtensionOrder.judge).pipe(
        Layer.provideMerge(ModelSpecs.layerNoDeps),
        Layer.provide(SettingsStore.layerNoDeps),
        Layer.provide(ModelHealth.layerNoDeps),
        Layer.provide(PiModelSource.layerFromModelSource),
        Layer.provide(source),
        Layer.provide(Database.layerTest(migrations))
      )
    );

    const specs = Context.get(services, ModelSpecs);
    const tool = Context.get(services, ModelsTool);

    const registry = createRegistry();

    registry.install(tool.extension.extension);

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(
            new MemoryStorage(),
            { models, registry, settings: {} },
            context
          )
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    const parent = yield* Effect.promise(
      async () =>
        await harness.commit(async (tx) => {
          const created = await tx.createConversation({
            ownership: { kind: "ownerless" },
          });

          await configure(tx, created.id, {
            model: PARENT,
            thinkingLevel: PARENT_LEVEL,
          });

          return created.id;
        }, context)
    );

    const agentOf = (id: ConversationId) =>
      Effect.promise(async () => await harness.snapshot(AgentDoc, id, context));

    /**
     * Creates a child in one commit: on the named spec, checked first, or on the parent's model
     * and (unless the control drops it) level, read before the commit.
     */
    const dispatch = Effect.fn("ModelDispatch.dispatch")(function* (
      spec: Option.Option<string>
    ) {
      const own = yield* agentOf(parent);

      const { model, level } = yield* Option.match(spec, {
        onNone: () =>
          Effect.succeed({
            model: own?.model ?? PARENT,
            level: Option.filter(
              Option.fromUndefinedOr(own?.thinkingLevel),
              () => inherit === "parent"
            ),
          }),
        onSome: (named) =>
          Effect.map(specs.resolve(named), (resolved) => ({
            model: resolved.model,
            level: Option.fromNullOr(resolved.thinkingLevel),
          })),
      });

      return yield* Effect.promise(
        async () =>
          await harness.commit(async (tx) => {
            const created = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });

            await (Option.isSome(level)
              ? configure(tx, created.id, { model, thinkingLevel: level.value })
              : configure(tx, created.id, { model }));

            return created.id;
          }, context)
      );
    });

    const send = (id: ConversationId, content: string) =>
      Effect.promise(async () => {
        const conversation = await harness.conversation(id, context);

        if (conversation === undefined) {
          throw new Error(`conversation ${String(id)} vanished`);
        }

        await conversation.submit(
          { type: "input", content, requestId: `r-${String(id)}-${content}` },
          context
        );

        await conversation.waitForIdle(context);
      });

    const childOf = (id: ConversationId) =>
      Effect.map(agentOf(id), (agent): ChildReport => ({
        model: Option.map(Option.fromUndefinedOr(agent?.model), (model) => ({
          provider: model.provider,
          modelId: model.modelId,
        })),
        thinkingLevel: Option.fromUndefinedOr(agent?.thinkingLevel),
      }));

    const childA = yield* dispatch(Option.none());

    yield* send(childA, "first");

    const childB = yield* dispatch(Option.some(text(NAMED)));

    yield* send(childB, "first");

    const refused = yield* dispatch(Option.some(MISSING_SPEC)).pipe(
      Effect.match({
        onFailure: (failure) => Option.some(failure.message),
        onSuccess: () => Option.none<string>(),
      })
    );

    const report: ScenarioReport = {
      a: yield* childOf(childA),
      b: yield* childOf(childB),
      calls: { alpha: alpha.state.callCount, beta: beta.state.callCount },
      refused,
      modelsToolText,
      searchedText,
    };

    return report;
  }).pipe(Effect.scoped);

/**
 * What the report breaks of ADR 0043, one sentence each; empty when it holds: a child that names
 * no model runs on its parent's model and level, a child that names a model runs on it, a named
 * model the catalog lacks is refused with the reason, and the `models` tool names the caller's own
 * model and every provider a child can run on.
 */
export const verdictOf = (report: ScenarioReport): ReadonlyArray<string> => {
  const failures: Array<string> = [];

  if (!Option.exists(report.a.model, (model) => sameModel(model, PARENT))) {
    failures.push(
      `child A named no model but runs on ${modelText(report.a.model)}, not its parent's ${text(PARENT)}`
    );
  }

  if (!Option.contains(report.a.thinkingLevel, PARENT_LEVEL)) {
    failures.push(
      `child A named no model but runs at ${Option.getOrElse(report.a.thinkingLevel, () => "no level")}, not its parent's ${PARENT_LEVEL}`
    );
  }

  if (!Option.exists(report.b.model, (model) => sameModel(model, NAMED))) {
    failures.push(
      `child B named ${text(NAMED)} but runs on ${modelText(report.b.model)}`
    );
  }

  if (report.calls.alpha !== 1 || report.calls.beta !== 3) {
    failures.push(
      `alpha served ${report.calls.alpha} requests and beta ${report.calls.beta}; child A should have run once on alpha and child B three times on beta`
    );
  }

  if (
    !Option.exists(report.refused, (why) =>
      why.includes("not in the model catalog")
    )
  ) {
    failures.push(
      `the dispatch naming ${MISSING_SPEC} was not refused for a model the catalog lacks: ${Option.getOrElse(report.refused, () => "it was dispatched")}`
    );
  }

  for (const expected of [
    `You run on ${text(NAMED)}`,
    `- ${text(PARENT)};`,
    `- ${text(NAMED)}, yours;`,
  ]) {
    if (!report.modelsToolText.includes(expected)) {
      failures.push(
        `the models tool did not say "${expected}": ${JSON.stringify(report.modelsToolText)}`
      );
    }
  }

  if (
    !report.searchedText.includes(`- ${text(PARENT)};`) ||
    report.searchedText.includes(`- ${text(NAMED)}`)
  ) {
    failures.push(
      `the models tool searched for ${PARENT.provider} did not list only its models: ${JSON.stringify(report.searchedText)}`
    );
  }

  return failures;
};
