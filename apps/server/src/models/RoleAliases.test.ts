// J-roles, the unit half (docs/phase-2/notes/models.md, "Judges"). The pure resolver over a world
// built from pi-ai's faux providers: the primary when it is ready; a fallback, with `skipped`
// filled, when the primary is limited, failing, missing a credential or not in the catalog;
// literal specs; an unbound role failing the check; the family warning; a binding that names a
// role refused by the store and passed over by the resolver; levels held to the model. Then the
// service over a migrated in-memory `cairn.sqlite`, real `ModelHealth` and the picker's catalog:
// the seeded table, a health limit and a spent Claude window passed over, the same spec resolving
// differently after the table changes, and a `RoleError` that lists what resolves now.

import type { ModelRef } from "@cairn/protocol/Models";
import type {
  RoleBinding,
  RoleOverrides,
  RoleTable,
  SkippedModel,
} from "@cairn/protocol/Roles";
import { DEFAULT_ROLE_TABLE, RoleCheck, RoleName } from "@cairn/protocol/Roles";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect";

import { ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { HealthOutcome, ModelHealth } from "./ModelHealth.ts";
import type { HealthState } from "./ModelHealth.ts";
import { PiModelSource } from "./PiModelSource.ts";
import type { RoleWorld } from "./RoleAliases.ts";
import {
  checkIn,
  parseRoleSpec,
  ParsedSpec,
  RoleAliases,
  rolesIn,
  rolesText,
  resolveIn,
} from "./RoleAliases.ts";
import { roleTableProblems, SettingsStore } from "./SettingsStore.ts";

const PRICE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

/** One collection holding the providers the defaults name, as faux providers. */
const makeModels = () => {
  const models = createModels();

  const providers = [
    fauxProvider({
      provider: "claude-bridge",
      models: [
        { id: "claude-opus-5-5", reasoning: true },
        { id: "claude-sonnet-5-5", reasoning: true },
      ],
    }),
    fauxProvider({
      provider: "anthropic",
      models: [
        { id: "claude-opus-5-5", cost: { ...PRICE, input: 4, output: 20 } },
        { id: "claude-sonnet-5-5", cost: PRICE },
      ],
    }),
    fauxProvider({
      provider: "opencode-go",
      models: [
        { id: "gpt-6-luna", reasoning: true, cost: PRICE },
        { id: "claude-haiku-5-5", cost: PRICE },
        { id: "beam-free" },
      ],
    }),
    fauxProvider({
      provider: "openai-codex",
      models: [{ id: "gpt-6-luna", reasoning: true, cost: PRICE }],
    }),
  ];

  for (const faux of providers) {
    models.setProvider(faux.provider);
  }

  return models;
};

const MODELS = makeModels();

const key = (model: ModelRef) => `${model.provider}/${model.modelId}`;

const ref = (provider: string, modelId: string): ModelRef => ({
  provider,
  modelId,
});

/** A world over the faux catalog: every model available unless named, every provider ok. */
const worldOf = (
  options: {
    readonly table?: RoleTable;
    readonly unavailable?: ReadonlyArray<string>;
    readonly health?: Readonly<Record<string, HealthState>>;
    readonly planLimited?: ReadonlyArray<string>;
  } = {}
): RoleWorld => ({
  table: options.table ?? DEFAULT_ROLE_TABLE,
  catalog: (model) =>
    Option.fromUndefinedOr(MODELS.getModel(model.provider, model.modelId)),
  available: (model) => !(options.unavailable ?? []).includes(key(model)),
  health: (provider) => options.health?.[provider] ?? "ok",
  planLimited: (model) => (options.planLimited ?? []).includes(key(model)),
});

const resolvedOrFail = (world: RoleWorld, spec: string) => {
  const result = resolveIn(world, spec);

  if (Result.isFailure(result)) {
    return assert.fail(
      `${spec} did not resolve: ${result.failure.reason} ${JSON.stringify(result.failure.skipped)}`
    );
  }

  return result.success;
};

const failureOf = (world: RoleWorld, spec: string) => {
  const result = resolveIn(world, spec);

  if (Result.isSuccess(result)) {
    return assert.fail(`${spec} resolved to ${key(result.success.model)}`);
  }

  return result.failure;
};

const binding = (
  model: ModelRef,
  fallbacks: ReadonlyArray<ModelRef> = []
): RoleTable[RoleName] => ({
  model,
  thinkingLevel: Option.none(),
  fallbacks,
  note: Option.none(),
});

const Resolution = RoleCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

const LUNA_ON_GO = ref("opencode-go", "gpt-6-luna");

const LUNA_ON_CODEX = ref("openai-codex", "gpt-6-luna");

describe("parsing a role spec", () => {
  it("reads roles, levels and literal models", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["@worker", "Role @worker -"],
      ["@worker:high", "Role @worker high"],
      ["opencode-go/gpt-6-luna", "Literal opencode-go/gpt-6-luna -"],
      [
        "openrouter/anthropic/claude-x:low",
        "Literal openrouter/anthropic/claude-x low",
      ],
      ["ollama/qwen3:8b", "Literal ollama/qwen3:8b -"],
    ];

    for (const [spec, expected] of cases) {
      const parsed = parseRoleSpec(spec);

      const text = Option.match(parsed, {
        onNone: () => "none",
        onSome: (found) =>
          ParsedSpec.$match(found, {
            Role: ({ role, level }) =>
              `Role ${role} ${Option.getOrElse(level, () => "-")}`,
            Literal: ({ model, level }) =>
              `Literal ${key(model)} ${Option.getOrElse(level, () => "-")}`,
          }),
      });

      assert.strictEqual(text, expected, spec);
    }
  });

  it("refuses what is neither a role nor provider/modelId", () => {
    for (const spec of ["worker", "@Worker", "@", "/model", "@worker/x", ""]) {
      assert.isTrue(Option.isNone(parseRoleSpec(spec)), spec);
    }
  });
});

describe("resolving against a world", () => {
  it("takes the primary when it is ready", () => {
    const resolved = resolvedOrFail(worldOf(), "@worker");

    assert.deepStrictEqual(
      resolved.model,
      ref("claude-bridge", "claude-opus-5-5")
    );
    assert.strictEqual(resolved.role, "@worker");
    assert.strictEqual(resolved.via, "primary");
    assert.strictEqual(resolved.thinkingLevel, "medium");
    assert.deepStrictEqual(resolved.skipped, []);
    assert.strictEqual(resolved.family, "anthropic");
    // A bridge model is priced as its anthropic twin.
    assert.isTrue(resolved.priced);
  });

  it("falls back past a primary that is limited, failing, signed out or unknown, naming why", () => {
    const cases: ReadonlyArray<
      readonly [Parameters<typeof worldOf>[0], SkippedModel["reason"]]
    > = [
      [{ health: { "openai-codex": "limited" } }, "limited"],
      [{ health: { "openai-codex": "failing" } }, "failing"],
      [{ unavailable: [key(LUNA_ON_CODEX)] }, "missing_credential"],
      [{ planLimited: [key(LUNA_ON_CODEX)] }, "limited"],
    ];

    for (const [options, reason] of cases) {
      const resolved = resolvedOrFail(worldOf(options), "@verifier");

      assert.deepStrictEqual(resolved.model, LUNA_ON_GO, reason);
      assert.strictEqual(resolved.via, "fallback");
      assert.deepStrictEqual(resolved.skipped, [
        { model: LUNA_ON_CODEX, reason },
      ]);
    }

    const table = {
      ...DEFAULT_ROLE_TABLE,
      [RoleName.make("@verifier")]: binding(ref("openai-codex", "gpt-9-gone"), [
        LUNA_ON_GO,
      ]),
    };

    assert.deepStrictEqual(
      resolvedOrFail(worldOf({ table }), "@verifier").skipped,
      [{ model: ref("openai-codex", "gpt-9-gone"), reason: "unknown_model" }]
    );
  });

  it("is unresolved with every candidate skipped when none is ready", () => {
    const failure = failureOf(
      worldOf({
        health: { "openai-codex": "failing", "opencode-go": "limited" },
      }),
      "@verifier"
    );

    assert.strictEqual(failure.reason, "no_ready_model");
    assert.deepStrictEqual(failure.skipped, [
      { model: LUNA_ON_CODEX, reason: "failing" },
      { model: LUNA_ON_GO, reason: "limited" },
    ]);
  });

  it("passes a literal spec through when its model is ready, and refuses it when not", () => {
    const resolved = resolvedOrFail(worldOf(), "opencode-go/claude-haiku-5-5");

    assert.deepStrictEqual(
      resolved.model,
      ref("opencode-go", "claude-haiku-5-5")
    );
    assert.strictEqual(resolved.via, "literal");
    assert.isNull(resolved.role);
    assert.isNull(resolved.thinkingLevel);
    assert.strictEqual(resolved.family, "anthropic");

    const failure = failureOf(
      worldOf({ health: { "opencode-go": "failing" } }),
      "opencode-go/claude-haiku-5-5"
    );

    assert.strictEqual(failure.reason, "no_ready_model");
    assert.deepStrictEqual(failure.skipped, [
      { model: ref("opencode-go", "claude-haiku-5-5"), reason: "failing" },
    ]);
  });

  it("fails an unbound role and an invalid spec", () => {
    assert.strictEqual(
      failureOf(worldOf(), "@reviewer").reason,
      "unbound_role"
    );
    assert.strictEqual(
      failureOf(worldOf(), "gpt-6-luna").reason,
      "invalid_spec"
    );
  });

  it("lets a spec's level win over the binding's and holds it to the model", () => {
    assert.strictEqual(
      resolvedOrFail(worldOf(), "@worker:high").thinkingLevel,
      "high"
    );
    // The faux models map no xhigh or max, so max is held to high.
    assert.strictEqual(
      resolvedOrFail(worldOf(), "@scout:max").thinkingLevel,
      "high"
    );
    // A model without reasoning takes only off.
    assert.strictEqual(
      resolvedOrFail(worldOf(), "opencode-go/claude-haiku-5-5:high")
        .thinkingLevel,
      "off"
    );
  });

  it("marks a model without a list price unpriced", () => {
    assert.isFalse(resolvedOrFail(worldOf(), "opencode-go/beam-free").priced);
  });

  it("uses a launch's override over the table for the role it names only", () => {
    const overrides: RoleOverrides = {
      [RoleName.make("@judge")]: {
        model: ref("opencode-go", "claude-haiku-5-5"),
        thinkingLevel: null,
        fallbacks: [],
        note: null,
      },
    };

    const judge = resolveIn(worldOf(), "@judge", Option.some(overrides));
    const scout = resolveIn(worldOf(), "@scout", Option.some(overrides));

    assert.deepStrictEqual(
      Result.map(judge, (found) => found.model),
      Result.succeed(ref("opencode-go", "claude-haiku-5-5"))
    );
    assert.deepStrictEqual(
      Result.map(scout, (found) => found.model),
      Result.succeed(ref("claude-bridge", "claude-sonnet-5-5"))
    );
  });

  it("passes over a binding that names a role, and the store refuses such a table", () => {
    const aliased = binding(ref("@worker", "x"), [LUNA_ON_GO]);

    const table = {
      ...DEFAULT_ROLE_TABLE,
      [RoleName.make("@judge")]: aliased,
    };

    const resolved = resolvedOrFail(worldOf({ table }), "@judge");

    assert.deepStrictEqual(resolved.model, LUNA_ON_GO);
    assert.deepStrictEqual(resolved.skipped, [
      { model: ref("@worker", "x"), reason: "unknown_model" },
    ]);

    assert.deepStrictEqual(roleTableProblems(table), [
      { role: "@judge", problem: "alias_binding" },
    ]);

    const withoutScout: Record<RoleName, RoleBinding> = {};

    for (const [role, kept] of Object.entries(DEFAULT_ROLE_TABLE)) {
      if (role !== "@scout") {
        withoutScout[RoleName.make(role)] = kept;
      }
    }

    assert.deepStrictEqual(roleTableProblems(withoutScout), [
      { role: "@scout", problem: "missing_built_in" },
    ]);
    assert.deepStrictEqual(roleTableProblems(DEFAULT_ROLE_TABLE), []);
  });
});

describe("checking specs for the brief card", () => {
  it("blocks an unbound role and warns when a judge shares the worker's family", () => {
    const table = {
      ...DEFAULT_ROLE_TABLE,
      [RoleName.make("@judge")]: binding(
        ref("opencode-go", "claude-haiku-5-5")
      ),
    };

    const checks = checkIn(worldOf({ table }), [
      "@worker",
      "@judge",
      "@verifier",
      "@scout",
      "@reviewer",
    ]);

    assert.deepStrictEqual(
      checks.map((check) => [
        check.spec,
        check.resolution._tag,
        check.sameFamilyAsWorker,
      ]),
      [
        ["@worker", "Resolved", false],
        ["@judge", "Resolved", true],
        ["@verifier", "Resolved", false],
        // Only a judge or a verifier is warned; a scout on the worker's family is expected.
        ["@scout", "Resolved", false],
        ["@reviewer", "Unresolved", false],
      ]
    );

    assert.deepStrictEqual(
      checkIn(worldOf(), ["@judge"]).map((check) => check.sameFamilyAsWorker),
      [false]
    );
  });
});

describe("the roles listing", () => {
  it("lists every role, built-ins first, with model, level, readiness and price", () => {
    const table = {
      ...DEFAULT_ROLE_TABLE,
      [RoleName.make("@advisor")]: binding(ref("opencode-go", "beam-free")),
    };

    const text = rolesText(
      rolesIn(worldOf({ table, health: { "openai-codex": "failing" } }))
    );

    assert.strictEqual(
      text,
      [
        "@worker: claude-bridge/claude-opus-5-5 at medium, ready; $4 in, $20 out per Mtok at API list price",
        "@scout: claude-bridge/claude-sonnet-5-5 at high, ready; $1 in, $2 out per Mtok at API list price",
        "@judge: opencode-go/gpt-6-luna, ready; $1 in, $2 out per Mtok at API list price",
        "@verifier: opencode-go/gpt-6-luna, ready, fallback after openai-codex/gpt-6-luna (its provider is failing); $1 in, $2 out per Mtok at API list price",
        "@advisor: opencode-go/beam-free, ready; no price listed",
        "",
        "Where a tool takes a model, pass a role (@worker), a role with a level (@worker:high), or provider/modelId[:level].",
      ].join("\n")
    );
  });
});

/** The service over a migrated in-memory database, real health, and the picker's faux catalog. */
const ServiceLayer = RoleAliases.layerNoDeps.pipe(
  Layer.provideMerge(SettingsStore.layerNoDeps),
  Layer.provideMerge(ModelHealth.layerNoDeps),
  Layer.provideMerge(PiModelSource.layerFromModelSource),
  Layer.provideMerge(
    Layer.mock(ModelSource)({
      models: () => MODELS,
      settings: () => ({}),
    })
  ),
  Layer.provide(Database.layerTest(migrations))
);

const patchOf = (roleBindings: RoleTable) => ({
  autoSettleDays: Option.none(),
  titleModel: Option.none(),
  bridgeEnabled: Option.none(),
  bridgeGenerationCap: Option.none(),
  roleBindings: Option.some(roleBindings),
  defaultBudget: Option.none(),
});

describe("the role alias service", () => {
  it.effect(
    "resolves the seeded table, then the changed table, never a stale one",
    () =>
      Effect.gen(function* () {
        const roles = yield* RoleAliases;
        const settings = yield* SettingsStore;

        const before = yield* roles.resolve("@judge", Option.none());

        assert.deepStrictEqual(before.model, LUNA_ON_GO);

        yield* settings.update(
          patchOf({
            ...DEFAULT_ROLE_TABLE,
            [RoleName.make("@judge")]: binding(
              ref("opencode-go", "claude-haiku-5-5")
            ),
          })
        );

        const after = yield* roles.resolve("@judge", Option.none());

        assert.deepStrictEqual(
          after.model,
          ref("opencode-go", "claude-haiku-5-5")
        );
        // What an earlier dispatch recorded is a value; the table change does not reach it.
        assert.deepStrictEqual(before.model, LUNA_ON_GO);
      }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("passes over a provider ModelHealth holds limited", () =>
    Effect.gen(function* () {
      const roles = yield* RoleAliases;
      const health = yield* ModelHealth;

      yield* health.record(
        "openai-codex",
        HealthOutcome.Failed({
          at: yield* DateTime.now,
          message:
            "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.",
        })
      );

      const resolved = yield* roles.resolve("@verifier", Option.none());

      assert.deepStrictEqual(resolved.model, LUNA_ON_GO);
      assert.deepStrictEqual(resolved.skipped, [
        { model: LUNA_ON_CODEX, reason: "limited" },
      ]);
    }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("fails an unknown role with the specs that resolve now", () =>
    Effect.gen(function* () {
      const roles = yield* RoleAliases;

      const failure = yield* Effect.flip(
        roles.resolve("@reviewer", Option.none())
      );

      assert.strictEqual(failure._tag, "RoleError");
      assert.include(failure.message, "no role by that name is bound");
      assert.include(failure.message, "@worker, @scout, @judge, @verifier");
    }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("checks without writing anything", () =>
    Effect.gen(function* () {
      const roles = yield* RoleAliases;

      const checks = yield* roles.check(["@judge", "@nobody"], Option.none());

      assert.deepStrictEqual(
        checks.map((check) => check.resolution._tag),
        ["Resolved", "Unresolved"]
      );
    }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("hides the bridge's models when the bridge is off", () =>
    Effect.gen(function* () {
      const roles = yield* RoleAliases;
      const settings = yield* SettingsStore;

      yield* settings.update({
        ...patchOf(DEFAULT_ROLE_TABLE),
        bridgeEnabled: Option.some(false),
      });

      const [worker] = yield* roles.check(["@worker"], Option.none());

      assert.deepStrictEqual(
        worker?.resolution,
        Resolution.cases.Unresolved.make({
          reason: "no_ready_model",
          skipped: [
            {
              model: ref("claude-bridge", "claude-opus-5-5"),
              reason: "missing_credential",
            },
          ],
        })
      );
    }).pipe(Effect.provide(ServiceLayer))
  );
});
