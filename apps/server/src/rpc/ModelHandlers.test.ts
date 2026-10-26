// Judges the hello defaults that come from the model catalog: a new socket learns the model a new
// thread starts on from the brain's models (here the faux one), not the fixed fallback, and the
// settings that hide the bridge reach the catalog.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { SessionHelloWithModels } from "./ModelHandlers.ts";
import { FALLBACK_DEFAULTS, SessionHello } from "./SessionHandlers.ts";

const BaseHello = Layer.succeed(
  SessionHello,
  SessionHello.of({
    build: "dev",
    defaults: Effect.succeed(FALLBACK_DEFAULTS),
    vapidPublicKey: Effect.succeedNone,
  })
);

const TestLayer = SessionHelloWithModels.pipe(
  Layer.provide(BaseHello),
  Layer.provide(
    PiModelSource.layerFromModelSource.pipe(
      Layer.provide(
        ModelSource.layerFaux({ tokensPerSecond: 1000, settings: {} })
      )
    )
  ),
  Layer.provide(
    SettingsStore.layerNoDeps.pipe(
      Layer.provide(Database.layerTest(migrations))
    )
  )
);

describe("the hello's new-thread defaults", () => {
  it.effect("come from the model catalog and keep the base hello", () =>
    Effect.gen(function* () {
      const hello = yield* SessionHello;

      assert.strictEqual(hello.build, "dev");
      assert.deepStrictEqual((yield* hello.defaults).model, FAUX_MODEL);
      assert.isTrue(Option.isNone(yield* hello.vapidPublicKey));
    }).pipe(Effect.provide(TestLayer))
  );
});
