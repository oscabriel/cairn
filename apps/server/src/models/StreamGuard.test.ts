// Judges the degenerate stream guard over pi-ai's faux provider, streaming four characters a delta
// so every run spans hundreds of deltas: 1,000 whitespace characters in a row inside a tool call's
// arguments end the response with an error pi-durable retries (pi-ai's `isRetryableAssistantError`,
// not an overflow) and abort the request, through `streamSimple` and `completeSimple` alike; 999 do
// not, a non-whitespace character resets the count, text is not counted, and the `claude-bridge`
// provider's stream passes untouched.

import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { BRIDGE_PROVIDER } from "./HarnessSettings.ts";
import {
  degenerateArgumentsMessage,
  guardModels,
  MAX_WHITESPACE_RUN,
} from "./StreamGuard.ts";

/** Faux models for `provider`, four characters a delta, answering `answer` once. */
const scripted = (provider: string, answer: AssistantMessage) => {
  const signals: Array<AbortSignal> = [];

  const step: FauxResponseStep = (_context, options) => {
    if (options?.signal !== undefined) {
      signals.push(options.signal);
    }

    return answer;
  };

  const faux = fauxProvider({
    provider,
    models: [{ id: "scripted" }],
    tokenSize: { min: 1, max: 1 },
  });

  const models = createModels();

  models.setProvider(faux.provider);
  faux.setResponses([step]);

  return { models: guardModels(models), model: faux.getModel(), signals };
};

/** One streamed request to a faux `provider` answering `answer`, through the guard. */
const respond = (provider: string, answer: AssistantMessage) =>
  Effect.promise(async () => {
    const { models, model, signals } = scripted(provider, answer);

    const stream = models.streamSimple(model, { messages: [] });

    const events: Array<AssistantMessageEvent> = [];

    for await (const event of stream) {
      events.push(event);
    }

    return {
      events,
      message: await stream.result(),
      aborted: signals.some((signal) => signal.aborted),
    };
  });

const writeCall = (content: string) =>
  fauxAssistantMessage(fauxToolCall("write", { content }), {
    stopReason: "toolUse",
  });

describe("the degenerate stream guard", () => {
  it.effect(
    "ends a tool call at 1,000 whitespace characters in a row, retryably",
    () =>
      Effect.gen(function* () {
        const { events, message, aborted } = yield* respond(
          "opencode-go",
          writeCall(" ".repeat(MAX_WHITESPACE_RUN))
        );

        assert.strictEqual(message.stopReason, "error");
        assert.strictEqual(
          message.errorMessage,
          degenerateArgumentsMessage("write")
        );
        assert.isTrue(isRetryableAssistantError(message));
        assert.isFalse(isContextOverflow(message));
        assert.isTrue(aborted);
        assert.strictEqual(events.at(-1)?.type, "error");
        assert.isFalse(events.some((event) => event.type === "toolcall_end"));
      })
  );

  it.effect("guards completeSimple, which streams through the guard", () =>
    Effect.gen(function* () {
      const { models, model, signals } = scripted(
        "opencode-go",
        writeCall(" ".repeat(MAX_WHITESPACE_RUN))
      );

      const message = yield* Effect.promise(
        async () => await models.completeSimple(model, { messages: [] })
      );

      assert.strictEqual(
        message.errorMessage,
        degenerateArgumentsMessage("write")
      );
      assert.isTrue(signals.some((signal) => signal.aborted));
    })
  );

  it.effect("lets 999 whitespace characters in a row through", () =>
    Effect.gen(function* () {
      const { message, aborted } = yield* respond(
        "opencode-go",
        writeCall(" ".repeat(MAX_WHITESPACE_RUN - 1))
      );

      assert.strictEqual(message.stopReason, "toolUse");
      assert.isFalse(aborted);
    })
  );

  it.effect("starts counting again after a non-whitespace character", () =>
    Effect.gen(function* () {
      const run = " ".repeat(MAX_WHITESPACE_RUN - 1);

      const { message } = yield* respond(
        "opencode-go",
        writeCall(`${run}x${run}x${run}`)
      );

      assert.strictEqual(message.stopReason, "toolUse");
    })
  );

  it.effect("does not count text", () =>
    Effect.gen(function* () {
      const { message } = yield* respond(
        "opencode-go",
        fauxAssistantMessage(fauxText(" ".repeat(5 * MAX_WHITESPACE_RUN)))
      );

      assert.strictEqual(message.stopReason, "stop");
    })
  );

  it.effect("leaves the bridge's stream untouched", () =>
    Effect.gen(function* () {
      const { message, aborted } = yield* respond(
        BRIDGE_PROVIDER,
        writeCall(" ".repeat(5 * MAX_WHITESPACE_RUN))
      );

      assert.strictEqual(message.stopReason, "toolUse");
      assert.isFalse(aborted);
    })
  );
});
