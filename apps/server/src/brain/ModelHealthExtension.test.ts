// The `model-health` extension under a real pi-durable Harness over pi-ai's faux provider, with
// retries on (two retries, a millisecond apart): a request records one outcome however many
// attempts it took. A transient failure that a retry mends records only the success; a request
// whose retries run out records one failure, not three; a failure pi-durable does not retry (a
// revoked key) and a transient one with retries off each record one failure at once.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import type { HealthOutcome } from "../models/ModelHealth.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { ModelHealthFeed } from "./ModelHealthExtension.ts";
import { ModelSource } from "./ModelSource.ts";

const context = BACKGROUND_CONTEXT;

const PROVIDER = "flaky";

const RETRIES_ON: HarnessSettings = {
  retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 1 },
};

const RETRIES_OFF: HarnessSettings = { retry: { enabled: false } };

/** A transient failure pi-ai's `isRetryableAssistantError` takes as retryable. */
const transient = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "fetch failed: ECONNRESET",
  });

/** An auth failure pi-ai never retries. */
const revoked = () =>
  fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "401 invalid_api_key",
  });

const answer = () => fauxAssistantMessage("hi");

/** Each outcome's tag, in the order recorded. */
type Recorded = Array<readonly [provider: string, tag: HealthOutcome["_tag"]]>;

/**
 * Runs one request through a Harness whose model answers `steps` in turn, with the feed installed
 * over a `ModelHealth` that only notes what it is told. Returns what was recorded and how many
 * attempts the provider saw.
 */
const runRequest = (
  settings: HarnessSettings,
  steps: ReadonlyArray<FauxResponseStep>
) =>
  Effect.gen(function* () {
    const recorded: Recorded = [];

    const health = Layer.mock(ModelHealth)({
      record: (provider, outcome) =>
        Effect.sync(() => {
          recorded.push([provider, outcome._tag]);
        }),
    });

    const faux = fauxProvider({
      provider: PROVIDER,
      models: [{ id: "small" }],
    });

    faux.setResponses([...steps]);

    const models = createModels();

    models.setProvider(faux.provider);

    const source = Layer.mock(ModelSource)({
      models: () => models,
      settings: () => settings,
    });

    // Built in the test's scope, so the feed's runtime outlives the Harness.
    const feed = Context.get(
      yield* Layer.build(
        ModelHealthFeed.layer.pipe(Layer.provide([health, source]))
      ),
      ModelHealthFeed
    );

    const registry = createRegistry();

    registry.install(feed.extension.extension);

    const harness = yield* Effect.acquireRelease(
      Effect.promise(
        async () =>
          await Harness.open(
            new MemoryStorage(),
            { models, registry, settings },
            context
          )
      ),
      (open) =>
        Effect.promise(async () => {
          await open.close(context);
        })
    );

    yield* Effect.promise(async () => {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: PROVIDER, modelId: "small" } },
        },
        context
      );

      await conversation.submit(
        { type: "input", content: "hello", requestId: "r-1" },
        context
      );

      await harness.waitForIdle(context);
    });

    return { recorded, attempts: faux.state.callCount };
  }).pipe(Effect.scoped);

describe("the model-health extension", () => {
  it.live("records only the success of a request a retry mended", () =>
    Effect.gen(function* () {
      const { recorded, attempts } = yield* runRequest(RETRIES_ON, [
        transient(),
        answer(),
      ]);

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(recorded, [[PROVIDER, "Succeeded"]]);
    })
  );

  it.live("records one failure for a request whose retries ran out", () =>
    Effect.gen(function* () {
      const { recorded, attempts } = yield* runRequest(RETRIES_ON, [
        transient(),
        transient(),
        transient(),
      ]);

      assert.strictEqual(attempts, 3);
      assert.deepStrictEqual(recorded, [[PROVIDER, "Failed"]]);
    })
  );

  it.live("records a failure pi-durable does not retry at once", () =>
    Effect.gen(function* () {
      const { recorded, attempts } = yield* runRequest(RETRIES_ON, [
        revoked(),
        answer(),
      ]);

      assert.strictEqual(attempts, 1);
      assert.deepStrictEqual(recorded, [[PROVIDER, "Failed"]]);
    })
  );

  it.live("records a transient failure at once with retries off", () =>
    Effect.gen(function* () {
      const { recorded, attempts } = yield* runRequest(RETRIES_OFF, [
        transient(),
        answer(),
      ]);

      assert.strictEqual(attempts, 1);
      assert.deepStrictEqual(recorded, [[PROVIDER, "Failed"]]);
    })
  );
});
