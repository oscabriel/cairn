// `roles.check` over the stubs, as `Handlers.ts` layers them, against the faux brain's catalog and a
// migrated in-memory `cairn.sqlite`: a spec the faux model can take resolves; a seeded role whose
// provider this brain does not have is blocked with the model it passed over; an unknown role is
// blocked as unbound; a failed read of the table answers `Unavailable`.

import { RoleCheck } from "@cairn/protocol/Roles";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import type { Scope } from "effect";
import { RpcTest } from "effect/rpc";

import { ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { RoleAliases, RoleAliasesUnavailable } from "../models/RoleAliases.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { ViewerTest } from "../shell/ShellTestKit.ts";
import { RoleHandlers } from "./RoleHandlers.ts";
import { stubHandlers } from "./StubHandlers.ts";

const Stubs = CairnRpcs.toLayer(Effect.succeed(CairnRpcs.of(stubHandlers)));

const Roles = RoleAliases.layerNoDeps.pipe(
  Layer.provide(SettingsStore.layerNoDeps),
  Layer.provide(ModelHealth.layerNoDeps),
  Layer.provide(PiModelSource.layerFromModelSource),
  Layer.provide(ModelSource.layerFaux({ tokensPerSecond: 1000, settings: {} })),
  Layer.provide(Database.layerTest(migrations)),
  Layer.orDie
);

const Resolution = RoleCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

/** Roles whose table cannot be read. */
const Broken = Layer.mock(RoleAliases)({
  check: () =>
    Effect.fail(
      new RoleAliasesUnavailable({
        message: "RoleAliases.check could not read the role table",
        operation: "RoleAliases.check",
        cause: "disk",
      })
    ),
});

const makeClient = RpcTest.makeClient(CairnRpcs);

const handlersWith = (roles: Layer.Layer<RoleAliases>) =>
  Layer.mergeAll(Stubs, RoleHandlers.pipe(Layer.provide(roles))).pipe(
    Layer.provideMerge(ViewerTest)
  );

const run = <A, E>(
  roles: Layer.Layer<RoleAliases>,
  body: Effect.Effect<
    A,
    E,
    Layer.Success<ReturnType<typeof handlersWith>> | Scope.Scope
  >
) => body.pipe(Effect.scoped, Effect.provide(handlersWith(roles)));

describe("roles.check", () => {
  it.effect("previews each spec without resolving anything for real", () =>
    run(
      Roles,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const checks = yield* client["roles.check"]({
          specs: ["faux/scripted", "@judge", "@reviewer"],
        });

        assert.deepStrictEqual(
          checks.map((check) => [check.spec, check.resolution._tag]),
          [
            ["faux/scripted", "Resolved"],
            ["@judge", "Unresolved"],
            ["@reviewer", "Unresolved"],
          ]
        );

        const [, judge, reviewer] = checks;

        assert.deepStrictEqual(
          judge?.resolution,
          Resolution.cases.Unresolved.make({
            reason: "no_ready_model",
            skipped: [
              {
                model: { provider: "opencode-go", modelId: "gpt-6-luna" },
                reason: "unknown_model",
              },
            ],
          })
        );
        assert.deepStrictEqual(
          reviewer?.resolution,
          Resolution.cases.Unresolved.make({
            reason: "unbound_role",
            skipped: [],
          })
        );
      })
    )
  );

  it.effect("answers unavailable when the table cannot be read", () =>
    run(
      Broken,
      Effect.gen(function* () {
        const client = yield* makeClient;

        const failure = yield* client["roles.check"]({
          specs: ["@worker"],
        }).pipe(Effect.flip);

        assert.strictEqual(failure._tag, "Unavailable");
      })
    )
  );
});
