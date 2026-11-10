// pi-ai's faux provider as the brain's models, for tests, judges and the dev server: the layer
// (`FauxModels.layer`) gives a `ModelSource` whose only model is `faux/scripted`, and its handle,
// through which a test scripts the answers. A test double: the deployed brain never loads it
// (`main.test.ts` walks `main.ts`'s imports).

import type { ModelRef } from "@cairn/protocol/Models";
import type {
  Context as ModelContext,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type {
  FauxModelDefinition,
  FauxProviderHandle,
  RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";

import { errorText } from "./Durable.ts";
import {
  BASE_HARNESS_SETTINGS,
  ModelCallError,
  ModelSource,
} from "./ModelSource.ts";

/** The provider and model the faux layer serves. */
export const FAUX_MODEL: ModelRef = { provider: "faux", modelId: "scripted" };

/** The faux provider behind `FauxModels.layer`, for scripting its answers. */
export class FauxModels extends Context.Service<
  FauxModels,
  { readonly faux: FauxProviderHandle }
>()("cairn/server/brain/FauxModels") {
  /**
   * pi-ai's faux provider as the only model, `faux/scripted`, streaming at `tokensPerSecond`, as
   * the brain's `ModelSource`. Its handle is `FauxModels`, so a test scripts the answers.
   */
  static readonly layer = (options: {
    readonly tokensPerSecond: number;
    readonly settings: HarnessSettings;
    /** The model's display name; pi-ai shows the id when it is absent. */
    readonly name?: string;
    /**
     * The tokens each streamed delta carries; pi-ai's default is 3 to 5. A long answer then takes
     * as long to stream but in fewer, larger deltas.
     */
    readonly tokensPerDelta?: number;
  }) =>
    Layer.effectContext(
      Effect.sync(() => {
        const definition: FauxModelDefinition = {
          id: FAUX_MODEL.modelId,
          input: ["text", "image"],
          contextWindow: 200_000,
          reasoning: true,
        };

        if (options.name !== undefined) {
          definition.name = options.name;
        }

        const fauxOptions: RegisterFauxProviderOptions = {
          provider: FAUX_MODEL.provider,
          models: [definition],
          tokensPerSecond: options.tokensPerSecond,
        };

        if (options.tokensPerDelta !== undefined) {
          fauxOptions.tokenSize = {
            min: options.tokensPerDelta,
            max: options.tokensPerDelta,
          };
        }

        const faux = fauxProvider(fauxOptions);

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
