// `models.check` over the stubs, as `Handlers.ts` layers them, against the faux brain's catalog and
// a migrated in-memory `cairn.sqlite`: a model the faux brain offers resolves at its level; a model
// the catalog lacks is blocked as unknown; a role name is blocked as removed (ADR 0043); a spec that
// is no spec is blocked as invalid; a failed read of the catalog answers `Unavailable`.

import { ModelCheck } from "@cairn/protocol/ModelSpecs";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { ModelSpecs, ModelSpecsUnavailable } from "../models/ModelSpecs.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { ModelCheckHandlers } from "./ModelCheckHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const Specs = ModelSpecs.layerNoDeps.pipe(
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provide(ModelHealth.layerNoDeps),
  Layer.provide(PiModelSource.layerFromModelSource),
  Layer.provide(ModelSource.layerFaux({ tokensPerSecond: 1000, settings: {} })),
  Layer.provide(Database.layerTest(migrations)),
  Layer.orDie
);

const Resolution = ModelCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

/** Specs whose catalog cannot be read. */
const Broken = Layer.mock(ModelSpecs)({
  check: () =>
    Effect.fail(
      new ModelSpecsUnavailable({
        message: "ModelSpecs.check could not read the catalog",
        operation: "ModelSpecs.check",
        cause: "disk",
      })
    ),
});

const makeClient = RpcTest.makeClient(CairnRpcs);

const handlersWith = (specs: Layer.Layer<ModelSpecs>) =>
  Layer.mergeAll(Stubs, ModelCheckHandlers.pipe(Layer.provide(specs))).pipe(
    Layer.provideMerge(ViewerTest)
  );

const run = <A, E>(
  specs: Layer.Layer<ModelSpecs>,
  body: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof handlersWith>> | Scope.Scope
  >
) => body.pipe(Effect.scoped, Effect.provide(handlersWith(specs)));

describe("models.check", () => {
  it.effect("previews each spec without resolving anything for real", () =>
    run(
      Specs,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const checks = yield* client["models.check"]({
          specs: [
            "faux/scripted:high",
            "opencode-go/gpt-6-luna",
            "@judge",
            "gpt-6-luna",
          ],
        });

        assert.deepStrictEqual(
          checks.map((check) =>
            Resolution.match(check.resolution, {
              Resolved: ({ resolved }) => [
                check.spec,
                `${resolved.model.provider}/${resolved.model.modelId}`,
                resolved.thinkingLevel,
              ],
              Unresolved: ({ reason }) => [check.spec, reason],
            })
          ),
          [
            ["faux/scripted:high", "faux/scripted", "high"],
            ["opencode-go/gpt-6-luna", "unknown_model"],
            ["@judge", "invalid_spec"],
            ["gpt-6-luna", "invalid_spec"],
          ]
        );
      })
    )
  );

  it.effect("answers unavailable when the catalog cannot be read", () =>
    run(
      Broken,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const failure = yield* client["models.check"]({
          specs: ["faux/scripted"],
        }).pipe(Effect.flip);

        assert.strictEqual(failure._tag, "Unavailable");
      })
    )
  );
});
