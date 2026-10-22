// The cheap model that names threads and branches (plan D43): one short request outside any
// conversation, never through the Claude bridge, so a ten-token answer never starts a `claude`
// child. Its callers always have a fallback, so this service never fails: no model, a failed
// request or an empty answer all read as none.
import type { ModelRef } from "@cairn/protocol/Models";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
} from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";

/** How long one naming request may take before the caller falls back. */
export const TITLE_MODEL_TIMEOUT = Duration.seconds(20);

/** The provider the bridge registers; it never names threads. */
const BRIDGE_PROVIDER = "claude-bridge";

const answerText = (message: AssistantMessage) =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();

/**
 * Decodes the first JSON object in a model's answer with `schema`. Models often wrap JSON in a
 * fenced block or a sentence, so the text between the first `{` and the last `}` is read.
 */
export const decodeJsonAnswer = <S extends Schema.Codec<unknown, unknown>>(
  schema: S,
  text: string
): Option.Option<S["Type"]> => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end <= start) {
    return Option.none();
  }

  return Schema.decodeOption(Schema.fromJsonString(schema))(
    text.slice(start, end + 1)
  );
};

/** Asks `model` one question through `models`, with the timeout; none on any failure. */
const completeOn = Effect.fn("TitleModel.complete")(function* (
  models: (typeof ModelSource)["Service"],
  model: ModelRef,
  prompt: string
) {
  if (model.provider === BRIDGE_PROVIDER) {
    return Option.none<string>();
  }

  const timestamp = yield* Clock.currentTimeMillis;

  const answer = yield* models
    .completeSimple(
      model,
      { messages: [{ role: "user", content: prompt, timestamp }] },
      {}
    )
    .pipe(
      Effect.timeout(TITLE_MODEL_TIMEOUT),
      Effect.tapError((cause) =>
        Effect.logWarning("title model request failed").pipe(
          Effect.annotateLogs({
            event: "title_model_failed",
            provider: model.provider,
            modelId: model.modelId,
            cause: cause.message,
          })
        )
      ),
      Effect.option
    );

  return Option.filter(
    Option.map(
      Option.filter(
        answer,
        (message) =>
          message.stopReason !== "error" && message.stopReason !== "aborted"
      ),
      answerText
    ),
    (text) => text !== ""
  );
});

/** Asks the configured cheap model one question. */
export class TitleModel extends Context.Service<
  TitleModel,
  {
    /** The model's text answer to `prompt`; none when no model is set or the request failed. */
    complete(prompt: string): Effect.Effect<Option.Option<string>>;
  }
>()("cairn/server/threads/TitleModel") {
  /** No model: every caller uses its fallback (a slug of the message). */
  static readonly layerNone = Layer.succeed(
    TitleModel,
    TitleModel.of({ complete: () => Effect.succeedNone })
  );

  /**
   * Asks `model` through `ModelSource`, with a timeout. The Claude bridge is refused, so it falls
   * back instead. Needs `ModelSource`.
   */
  static readonly layerFixed = (model: ModelRef) =>
    Layer.effect(
      TitleModel,
      ModelSource.useSync((models) =>
        TitleModel.of({
          complete: (prompt) => completeOn(models, model, prompt),
        })
      )
    );

  /**
   * The model named by the `titleModel` server setting, read at each request, so a change applies
   * to the next title without a restart. No setting, or a settings read that fails, uses the
   * fallback. Needs `ModelSource` and `SettingsStore`.
   */
  static readonly layerFromSettings = Layer.effect(
    TitleModel,
    Effect.gen(function* () {
      const models = yield* ModelSource;
      const settings = yield* SettingsStore;

      const complete = Effect.fn("TitleModel.completeFromSettings")(function* (
        prompt: string
      ) {
        const chosen = yield* settings.get.pipe(
          Effect.map((current) => current.titleModel),
          Effect.catchTag("SettingsStoreError", () => Effect.succeedNone)
        );

        if (Option.isNone(chosen)) {
          return Option.none<string>();
        }

        return yield* completeOn(models, chosen.value, prompt);
      });

      return TitleModel.of({ complete });
    })
  );
}
