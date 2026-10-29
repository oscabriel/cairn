// Judges the hello defaults that come from the model catalog: a new socket learns the model a new
// thread starts on from the brain's models (here the faux one), not the fixed fallback, and the
// settings that hide the bridge reach the catalog. Then `settings.update` over `RpcTest`: a role
// table the store refuses answers `InvalidInput` naming `roleBindings` and changes nothing.

import { InvalidInput } from "@cairn/protocol/Errors";
import type { RoleBinding } from "@cairn/protocol/Roles";
import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { RpcTest } from "effect/rpc";

import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import {
  SessionHelloWithModels,
  SettingsGetHandler,
  SettingsUpdateHandler,
} from "./ModelHandlers.ts";
import { FALLBACK_DEFAULTS, SessionHello } from "./SessionHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

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

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const SettingsHandlers = Layer.mergeAll(
  Stubs,
  Layer.mergeAll(SettingsGetHandler, SettingsUpdateHandler).pipe(
    Layer.provide(
      SettingsStore.layerNoDeps.pipe(
        Layer.provide(Database.layerTest(migrations))
      )
    )
  )
).pipe(Layer.provideMerge(ViewerTest));

describe("settings.update", () => {
  it.effect(
    "answers InvalidInput naming roleBindings for a table without @judge, and changes nothing",
    () =>
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(CairnRpcs);

        const withoutJudge: Record<RoleName, RoleBinding> = {};

        for (const [role, binding] of Object.entries(DEFAULT_ROLE_TABLE)) {
          if (role !== "@judge") {
            withoutJudge[RoleName.make(role)] = binding;
          }
        }

        const before = yield* client["settings.get"]();

        const failure = yield* client["settings.update"]({
          autoSettleDays: Option.none(),
          titleModel: Option.none(),
          bridgeEnabled: Option.some(!before.bridgeEnabled),
          bridgeGenerationCap: Option.none(),
          roleBindings: Option.some(withoutJudge),
          defaultBudget: Option.none(),
        }).pipe(Effect.flip);

        assert.instanceOf(failure, InvalidInput);
        assert.deepStrictEqual(failure.field, Option.some("roleBindings"));
        assert.include(failure.message, "@judge");

        assert.deepStrictEqual(yield* client["settings.get"](), before);
      }).pipe(Effect.scoped, Effect.provide(SettingsHandlers))
  );
});
