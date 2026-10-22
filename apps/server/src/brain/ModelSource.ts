// Where the brain's models and run settings come from. The production layer (pi's model runtime,
// read-only over `~/.pi/agent`, with the Claude bridge registered) is built in `models/`; this module
// owns the service and its faux layer, which runs pi-ai's scripted provider for tests, judges and
// the dev server. Both are read at each use, so a credential or settings change needs no reopen.

import type { ModelRef } from "@cairn/protocol/Models";
import type {
  AssistantMessage,
  Context as ModelContext,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Schema } from "effect";

import { errorText } from "./Durable.ts";
import { FauxModels } from "./FauxModels.ts";

/** A direct model call (a title, a branch name) failed. */
export class ModelCallError extends Schema.TaggedError<ModelCallError>()(
  "ModelCallError",
  {
    message: Schema.String,
    provider: Schema.String,
    modelId: Schema.String,
    reason: Schema.Literals(["unknown_model", "request_failed"]),
  }
) {}

/**
 * Run settings every Cairn harness starts from (plan D17): a failed run leaves the inputs queued
 * behind it, shown as "queued, will run when you send again", instead of sending them silently.
 */
export const BASE_HARNESS_SETTINGS: HarnessSettings = {
  afterFailedRun: "keep",
};

/** The provider and model the faux layer serves. */
export const FAUX_MODEL: ModelRef = { provider: "faux", modelId: "scripted" };

/** The brain's models and run settings. */
export class ModelSource extends Context.Service<
  ModelSource,
  {
    /** The current models, read by pi-durable at each use. */
    models(): Models;
    /** The current run settings, read by pi-durable at each use. Synchronous: some readers hold the Session line. */
    settings(): HarnessSettings;
    /** One request outside any conversation, for small jobs such as a title. */
    completeSimple(
      model: ModelRef,
      context: ModelContext,
      options: SimpleStreamOptions
    ): Effect.Effect<AssistantMessage, ModelCallError>;
  }
>()("cairn/server/brain/ModelSource") {
  /**
   * pi-ai's faux provider as the only model, `faux/scripted`, streaming at `tokensPerSecond`. Its
   * handle is `FauxModels`, so a test scripts the answers.
   */
  static readonly layerFaux = (options: {
    readonly tokensPerSecond: number;
    readonly settings: HarnessSettings;
  }) =>
    Layer.effectContext(
      Effect.sync(() => {
        const faux = fauxProvider({
          provider: FAUX_MODEL.provider,
          models: [
            {
              id: FAUX_MODEL.modelId,
              input: ["text", "image"],
              contextWindow: 200_000,
              reasoning: true,
            },
          ],
          tokensPerSecond: options.tokensPerSecond,
        });

        const models = createModels();

        models.setProvider(faux.provider);

        const settings = { ...BASE_HARNESS_SETTINGS, ...options.settings };

        const completeSimple = Effect.fn("ModelSource.completeSimple")(
          function* (
            model: ModelRef,
            context: ModelContext,
            streamOptions: SimpleStreamOptions
          ) {
            const found = models.getModel(model.provider, model.modelId);

            if (found === undefined) {
              return yield* new ModelCallError({
                message: `The model ${model.provider}/${model.modelId} is not known. Pick another model.`,
                provider: model.provider,
                modelId: model.modelId,
                reason: "unknown_model",
              });
            }

            return yield* Effect.tryPromise({
              try: async (signal) =>
                await models.completeSimple(found, context, {
                  ...streamOptions,
                  signal,
                }),
              catch: (cause) =>
                new ModelCallError({
                  message: `The request to ${model.provider}/${model.modelId} failed: ${errorText(cause)}`,
                  provider: model.provider,
                  modelId: model.modelId,
                  reason: "request_failed",
                }),
            });
          }
        );

        return Context.make(
          ModelSource,
          ModelSource.of({
            models: () => models,
            settings: () => settings,
            completeSimple,
          })
        ).pipe(Context.add(FauxModels, FauxModels.of({ faux })));
      })
    );
}
