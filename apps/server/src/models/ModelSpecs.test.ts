// Model specs (ADR 0043), the pure half over a world built from pi-ai's faux providers: parsing a
// spec (a model with or without a level, a model id holding `@`, junk, a role name among it); a
// named model resolving when it is ready, its level held to the levels the model takes and priced
// from the catalog; each reason a model is not ready refusing it; a role name refused as no spec.
// Then the `models` listing: the caller's own model first, a short list per
// provider that always keeps the caller's model, a search by provider id or by model words, an
// unready provider said. Then the service over a migrated in-memory `cairn.sqlite`, real
// `ModelHealth` and the picker's catalog: a health limit refuses with a message that says what to
// do, and the bridge's models are unready when the bridge is off. Then the Claude plan's windows
// through `BridgeProvider` over a fixed `ClaudeUsage` reading: a spent window refuses a bridge
// model until its reset (or, unstated, for `UNSTATED_LIMIT_MS`), a `seven_day_<model>` window stops
// only its model, and `monthly_spend` stops nothing.

import { ClaudeUsage, INITIAL_READING } from "@cairn/bridge/ClaudeUsage";
import type { UsageWindow } from "@cairn/bridge/ClaudeUsage";
import type { ModelRef, ThinkingLevel } from "@cairn/protocol/Models";
import { ModelCheck } from "@cairn/protocol/ModelSpecs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { ModelSource } from "../brain/ModelSource.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { BridgeProvider } from "./BridgeProvider.ts";
import {
  HealthOutcome,
  ModelHealth,
  UNSTATED_LIMIT_MS,
} from "./ModelHealth.ts";
import type { HealthState } from "./ModelHealth.ts";
import type { ModelWorld } from "./ModelSpecs.ts";
import {
  checkIn,
  LISTED_MODEL_LIMIT,
  listIn,
  ModelSpecError,
  ModelSpecs,
  modelsText,
  parseModelSpec,
  resolveIn,
  specOf,
  unreadyOf,
} from "./ModelSpecs.ts";
import { PiModelSource } from "./PiModelSource.ts";
import { SettingsStore } from "./SettingsStore.ts";

const PRICE = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };

/** Twelve priced models of one provider, more than the short list holds. */
const MANY = Array.from({ length: 12 }, (_, index) => ({
  id: `kimi-k${String(index + 1)}`,
  cost: PRICE,
}));

/** One collection holding the providers the tests name, as faux providers. */
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
    fauxProvider({ provider: "moonshot", models: MANY }),
    fauxProvider({
      provider: "openrouter",
      models: [{ id: "anthropic/claude-x", cost: PRICE }],
    }),
    fauxProvider({
      provider: "cloudflare-workers-ai",
      models: [{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }],
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

/** Every model of the faux catalog, in its order. */
const ALL: ReadonlyArray<Model<Api>> = MODELS.getModels();

/** A world over the faux catalog: every model available unless named, every provider ok. */
const worldOf = (
  options: {
    readonly unavailable?: ReadonlyArray<string>;
    readonly health?: Readonly<Record<string, HealthState>>;
    readonly planLimited?: ReadonlyArray<string>;
  } = {}
): ModelWorld => {
  const available = (model: ModelRef) =>
    !(options.unavailable ?? []).includes(key(model));

  return {
    catalog: (model) =>
      Option.fromUndefinedOr(MODELS.getModel(model.provider, model.modelId)),
    offered: ALL.filter((model) =>
      available({ provider: model.provider, modelId: model.id })
    ),
    available,
    health: (provider) => options.health?.[provider] ?? "ok",
    planLimited: (model) => (options.planLimited ?? []).includes(key(model)),
  };
};

const resolvedOrFail = (world: ModelWorld, spec: string) => {
  const result = resolveIn(world, spec);

  if (Result.isFailure(result)) {
    return assert.fail(`${spec} did not resolve: ${result.failure.reason}`);
  }

  return result.success;
};

const failureOf = (world: ModelWorld, spec: string) => {
  const result = resolveIn(world, spec);

  if (Result.isSuccess(result)) {
    return assert.fail(`${spec} resolved to ${key(result.success.model)}`);
  }

  return result.failure.reason;
};

const Resolution = ModelCheck.fields.resolution.pipe(
  Schema.toTaggedUnion("_tag")
);

const LUNA_ON_GO = ref("opencode-go", "gpt-6-luna");

describe("parsing a model spec", () => {
  it("reads models with and without a level", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["opencode-go/gpt-6-luna", "Named opencode-go/gpt-6-luna -"],
      ["opencode-go/gpt-6-luna:high", "Named opencode-go/gpt-6-luna high"],
      [
        "openrouter/anthropic/claude-x:low",
        "Named openrouter/anthropic/claude-x low",
      ],
      ["ollama/qwen3:8b", "Named ollama/qwen3:8b -"],
      [
        "cloudflare-workers-ai/@cf/meta/llama-4-scout",
        "Named cloudflare-workers-ai/@cf/meta/llama-4-scout -",
      ],
    ];

    for (const [spec, expected] of cases) {
      const text = Option.match(parseModelSpec(spec), {
        onNone: () => "none",
        onSome: ({ model, level }) =>
          `Named ${key(model)} ${Option.getOrElse(level, () => "-")}`,
      });

      assert.strictEqual(text, expected, spec);
    }
  });

  it("reads back every model of pi-ai's catalog, with and without a level", () => {
    // Each model id pi-ai lists (OpenRouter's `~` aliases and `:free` ids, Bedrock's `:0`, Workers
    // AI's `@cf/...`): the first `/` ends the provider, and a trailing `:level` is the level, which
    // no listed id ends in.
    const unread = getBuiltinProviders().flatMap((provider) =>
      getBuiltinModels(provider).flatMap((model) => {
        const named = ref(provider, model.id);

        return [
          Option.none<ThinkingLevel>(),
          Option.some<ThinkingLevel>("high"),
        ].flatMap((level) => {
          const spec = specOf(named, level);

          const readBack = Option.exists(
            parseModelSpec(spec),
            (parsed) =>
              key(parsed.model) === key(named) &&
              Option.getOrNull(parsed.level) === Option.getOrNull(level)
          );

          return readBack ? [] : [spec];
        });
      })
    );

    assert.deepStrictEqual(unread, []);
  });

  it("refuses what is not provider/modelId, a role name among it", () => {
    for (const spec of [
      "worker",
      "@worker",
      "@scout:high",
      "@",
      "/model",
      "@worker/x",
      "",
    ]) {
      assert.isTrue(Option.isNone(parseModelSpec(spec)), spec);
    }
  });
});

describe("whether a model is ready", () => {
  it("names why a model cannot take a child, and none when it can", () => {
    const cases: ReadonlyArray<
      readonly [Parameters<typeof worldOf>[0], ModelRef, string]
    > = [
      [{}, LUNA_ON_GO, "ready"],
      [{}, ref("opencode-go", "gpt-9-gone"), "unknown_model"],
      [{ unavailable: [key(LUNA_ON_GO)] }, LUNA_ON_GO, "missing_credential"],
      [{ health: { "opencode-go": "failing" } }, LUNA_ON_GO, "failing"],
      [{ health: { "opencode-go": "limited" } }, LUNA_ON_GO, "limited"],
      [{ planLimited: [key(LUNA_ON_GO)] }, LUNA_ON_GO, "limited"],
    ];

    for (const [options, model, expected] of cases) {
      assert.strictEqual(
        Option.getOrElse(unreadyOf(worldOf(options), model), () => "ready"),
        expected,
        expected
      );
    }
  });
});

describe("resolving against a world", () => {
  it("takes a ready model at its level, priced from the catalog", () => {
    const resolved = resolvedOrFail(
      worldOf(),
      "claude-bridge/claude-opus-5-5:medium"
    );

    assert.deepStrictEqual(resolved, {
      spec: resolved.spec,
      model: ref("claude-bridge", "claude-opus-5-5"),
      thinkingLevel: "medium",
      // A bridge model is priced as its anthropic twin.
      priced: true,
    });
    assert.strictEqual(resolved.spec, "claude-bridge/claude-opus-5-5:medium");
  });

  it("leaves the level null when the spec names none", () => {
    assert.isNull(
      resolvedOrFail(worldOf(), "opencode-go/gpt-6-luna").thinkingLevel
    );
  });

  it("holds a spec's level to the levels the model takes", () => {
    // The faux models map no xhigh or max, so max is held to high.
    assert.strictEqual(
      resolvedOrFail(worldOf(), "claude-bridge/claude-sonnet-5-5:max")
        .thinkingLevel,
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

  it("takes a model whose id starts with @, which is no role name", () => {
    const llama = ref(
      "cloudflare-workers-ai",
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    );

    assert.deepStrictEqual(resolvedOrFail(worldOf(), key(llama)).model, llama);
  });

  it("refuses a model that is not ready, naming why, and never replaces it", () => {
    const cases: ReadonlyArray<
      readonly [Parameters<typeof worldOf>[0], string, string]
    > = [
      [{}, "opencode-go/gpt-9-gone", "unknown_model"],
      [
        { unavailable: [key(LUNA_ON_GO)] },
        key(LUNA_ON_GO),
        "missing_credential",
      ],
      [{ health: { "opencode-go": "failing" } }, key(LUNA_ON_GO), "failing"],
      [{ health: { "opencode-go": "limited" } }, key(LUNA_ON_GO), "limited"],
      [{ planLimited: [key(LUNA_ON_GO)] }, key(LUNA_ON_GO), "limited"],
    ];

    for (const [options, spec, reason] of cases) {
      assert.strictEqual(failureOf(worldOf(options), spec), reason, reason);
    }
  });

  it("refuses junk as no spec, a role name among it", () => {
    assert.strictEqual(failureOf(worldOf(), "@worker"), "invalid_spec");
    assert.strictEqual(failureOf(worldOf(), "@judge:high"), "invalid_spec");
    assert.strictEqual(failureOf(worldOf(), "gpt-6-luna"), "invalid_spec");
  });
});

describe("checking specs for the brief card", () => {
  it("previews each spec: resolved, or why Go is blocked", () => {
    const checks = checkIn(worldOf({ health: { anthropic: "failing" } }), [
      "opencode-go/gpt-6-luna:low",
      "anthropic/claude-opus-5-5",
      "@worker",
      " ",
    ]);

    assert.deepStrictEqual(
      checks.map((check) =>
        Resolution.match(check.resolution, {
          Resolved: ({ resolved }) => [
            check.spec,
            `${key(resolved.model)} ${resolved.thinkingLevel ?? "-"}`,
          ],
          Unresolved: ({ reason }) => [check.spec, reason],
        })
      ),
      [
        ["opencode-go/gpt-6-luna:low", "opencode-go/gpt-6-luna low"],
        ["anthropic/claude-opus-5-5", "failing"],
        ["@worker", "invalid_spec"],
        ["(empty)", "invalid_spec"],
      ]
    );
  });
});

/** A caller on `model` at `level`. */
const callerOn = (model: ModelRef, level?: "low" | "high") => ({
  model: Option.some(model),
  thinkingLevel: Option.fromUndefinedOr(level),
});

describe("the models listing", () => {
  it("names the caller's own model first and lists each provider's models", () => {
    const listing = listIn(
      worldOf({ unavailable: [key(ref("moonshot", "kimi-k1"))] }),
      callerOn(LUNA_ON_GO, "high"),
      Option.none()
    );

    const text = modelsText(listing);

    assert.isTrue(
      text.startsWith(
        "You run on opencode-go/gpt-6-luna:high. A child that names no model runs on that too.\n"
      ),
      text
    );
    assert.deepStrictEqual(
      listing.providers.map((provider) => provider.provider),
      [
        "claude-bridge",
        "anthropic",
        "opencode-go",
        "moonshot",
        "openrouter",
        "cloudflare-workers-ai",
      ]
    );
    assert.include(
      text,
      "- opencode-go/gpt-6-luna, yours; levels off, minimal, low, medium, high; $1 in, $2 out per Mtok"
    );
    assert.include(
      text,
      "- opencode-go/beam-free; no thinking levels; no price listed"
    );
    // A model with no usable credential is not offered at all.
    assert.notInclude(text, "moonshot/kimi-k1;");
  });

  it("cuts a provider to the short list, keeping the caller's own model and counting the rest", () => {
    const own = ref("moonshot", "kimi-k12");

    const listing = listIn(worldOf(), callerOn(own), Option.none());

    const moonshot = listing.providers.find(
      (provider) => provider.provider === "moonshot"
    );

    assert.deepStrictEqual(
      moonshot?.models.map((listed) => listed.model.modelId),
      [
        ...MANY.slice(0, LISTED_MODEL_LIMIT).map((model) => model.id),
        "kimi-k12",
      ]
    );
    assert.strictEqual(moonshot?.omitted, MANY.length - LISTED_MODEL_LIMIT - 1);
    assert.include(modelsText(listing), "- moonshot/kimi-k12, yours;");
    assert.include(
      modelsText(listing),
      `  ${String(MANY.length - LISTED_MODEL_LIMIT - 1)} more; pass search to find them.`
    );
  });

  it("lists only the provider a search names by its id", () => {
    const listing = listIn(
      worldOf(),
      callerOn(LUNA_ON_GO),
      Option.some("Anthropic")
    );

    assert.deepStrictEqual(
      listing.providers.map((provider) => [
        provider.provider,
        provider.models.map((listed) => listed.model.modelId),
      ]),
      [["anthropic", ["claude-opus-5-5", "claude-sonnet-5-5"]]]
    );
  });

  it("filters by model words across providers and cuts the matches", () => {
    const sonnet = listIn(
      worldOf(),
      callerOn(LUNA_ON_GO),
      Option.some("claude sonnet")
    );

    assert.deepStrictEqual(
      sonnet.providers.map((provider) =>
        provider.models.map((listed) => key(listed.model))
      ),
      [["claude-bridge/claude-sonnet-5-5"], ["anthropic/claude-sonnet-5-5"]]
    );

    const kimi = listIn(worldOf(), callerOn(LUNA_ON_GO), Option.some("kimi"));

    assert.strictEqual(kimi.providers[0]?.models.length, LISTED_MODEL_LIMIT);
    assert.strictEqual(
      kimi.providers[0]?.omitted,
      MANY.length - LISTED_MODEL_LIMIT
    );
  });

  it("says when a provider is failing or limited, and when nothing matches", () => {
    const text = modelsText(
      listIn(
        worldOf({ health: { anthropic: "failing", "opencode-go": "limited" } }),
        callerOn(LUNA_ON_GO),
        Option.none()
      )
    );

    assert.include(
      text,
      "anthropic (no child starts here now: its provider is failing):"
    );
    assert.include(
      text,
      "opencode-go (no child starts here now: its plan limit is reached):"
    );

    assert.include(
      modelsText(
        listIn(worldOf(), callerOn(LUNA_ON_GO), Option.some("no-such-model"))
      ),
      'No model matches "no-such-model".'
    );
  });
});

/** The service over a migrated in-memory database, real health, and the picker's faux catalog. */
const ServiceLayer = ModelSpecs.layerNoDeps.pipe(
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

describe("the model spec service", () => {
  it.effect(
    "refuses a model ModelHealth holds limited, saying what to do",
    () =>
      Effect.gen(function* () {
        const specs = yield* ModelSpecs;
        const health = yield* ModelHealth;

        assert.deepStrictEqual(
          (yield* specs.resolve(key(LUNA_ON_GO))).model,
          LUNA_ON_GO
        );

        yield* health.record(
          "opencode-go",
          HealthOutcome.Failed({
            at: yield* DateTime.now,
            message:
              "You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.",
          })
        );

        const failure = yield* Effect.flip(specs.resolve(key(LUNA_ON_GO)));

        assert.instanceOf(failure, ModelSpecError);
        assert.strictEqual(failure.reason, "limited");
        assert.include(failure.message, "its plan limit is reached");
        assert.include(failure.message, "Call models");
        assert.include(failure.message, "leave the model out");
      }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("refuses a role name as no spec", () =>
    Effect.gen(function* () {
      const specs = yield* ModelSpecs;

      const failure = yield* Effect.flip(specs.resolve("@worker"));

      assert.instanceOf(failure, ModelSpecError);
      assert.strictEqual(failure.reason, "invalid_spec");
      assert.include(failure.message, "provider/modelId[:level]");
    }).pipe(Effect.provide(ServiceLayer))
  );

  it.effect("holds the bridge's models unready when the bridge is off", () =>
    Effect.gen(function* () {
      const specs = yield* ModelSpecs;
      const settings = yield* SettingsStore;

      yield* settings.update({
        autoSettleDays: Option.none(),
        titleModel: Option.none(),
        bridgeEnabled: Option.some(false),
        bridgeGenerationCap: Option.none(),
        defaultBudget: Option.none(),
      });

      const [opus] = yield* specs.check(["claude-bridge/claude-opus-5-5"]);

      assert.deepStrictEqual(
        opus?.resolution,
        Resolution.cases.Unresolved.make({ reason: "missing_credential" })
      );

      const listing = yield* specs.list(callerOn(LUNA_ON_GO), Option.none());

      assert.notInclude(
        listing.providers.map((provider) => provider.provider),
        "claude-bridge"
      );
    }).pipe(Effect.provide(ServiceLayer))
  );
});

const HOUR_MS = 60 * 60_000;

/** A spent plan window, observed at time zero. */
const spentWindow = (
  id: string,
  resetsAt: Option.Option<number>
): UsageWindow => ({
  id,
  kind: id === "monthly_spend" ? "monthly" : "weekly",
  label: id,
  windowDurationMins: Option.none(),
  usedPercent: 100,
  resetsAt,
  observedAt: 0,
  exhausted: true,
});

/** The service with a bridge whose `ClaudeUsage` always answers `windows`, read at time zero. */
const withWindows = (windows: ReadonlyArray<UsageWindow>) => {
  const reading = {
    ...INITIAL_READING,
    state: "limited" as const,
    windows,
    checkedAt: Option.some(0),
  };

  const usage = ClaudeUsage.of({
    current: Effect.succeed(reading),
    changes: Stream.make(reading),
    watch: Stream.empty,
    observe: () => Effect.void,
    probe: Effect.void,
  });

  return ServiceLayer.pipe(
    Layer.provide(
      Layer.succeed(BridgeProvider, {
        claude: Option.none(),
        usage: Option.some(usage),
      })
    )
  );
};

const SONNET_ON_BRIDGE = key(ref("claude-bridge", "claude-sonnet-5-5"));

const OPUS_ON_BRIDGE = key(ref("claude-bridge", "claude-opus-5-5"));

/** Each spec's resolved model, or why not. */
const outcomes = (specs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const checks = yield* (yield* ModelSpecs).check(specs);

    return checks.map((check) =>
      Resolution.match(check.resolution, {
        Resolved: ({ resolved }) => key(resolved.model),
        Unresolved: ({ reason }) => reason,
      })
    );
  });

describe("the Claude plan's windows", () => {
  it.effect(
    "hold a bridge model unready while a spent window has not reset",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* outcomes([SONNET_ON_BRIDGE]), [
          "limited",
        ]);

        yield* TestClock.adjust(HOUR_MS - 1);

        assert.deepStrictEqual(yield* outcomes([SONNET_ON_BRIDGE]), [
          "limited",
        ]);

        // At the named reset the stale reading stops counting, with no new probe.
        yield* TestClock.adjust(1);

        assert.deepStrictEqual(yield* outcomes([SONNET_ON_BRIDGE]), [
          SONNET_ON_BRIDGE,
        ]);
      }).pipe(
        Effect.provide(
          withWindows([spentWindow("five_hour", Option.some(HOUR_MS))])
        )
      )
  );

  it.effect("hold a spent window with no reset for the unstated span", () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(UNSTATED_LIMIT_MS - 1);

      assert.deepStrictEqual(yield* outcomes([SONNET_ON_BRIDGE]), ["limited"]);

      yield* TestClock.adjust(1);

      assert.deepStrictEqual(yield* outcomes([SONNET_ON_BRIDGE]), [
        SONNET_ON_BRIDGE,
      ]);
    }).pipe(
      Effect.provide(withWindows([spentWindow("five_hour", Option.none())]))
    )
  );

  it.effect("stop only the model a seven_day_<model> window names", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* outcomes([OPUS_ON_BRIDGE, SONNET_ON_BRIDGE]),
        ["limited", SONNET_ON_BRIDGE]
      );
    }).pipe(
      Effect.provide(
        withWindows([spentWindow("seven_day_opus", Option.some(HOUR_MS))])
      )
    )
  );

  it.effect("ignore a spent monthly_spend", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* outcomes([OPUS_ON_BRIDGE, SONNET_ON_BRIDGE]),
        [OPUS_ON_BRIDGE, SONNET_ON_BRIDGE]
      );
    }).pipe(
      Effect.provide(
        withWindows([spentWindow("monthly_spend", Option.some(HOUR_MS))])
      )
    )
  );
});
