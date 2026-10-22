// Judges the brain's model source: the listing (available models, extra providers shown disabled
// when signed out, refused and turned-off providers hidden), pi's defaults against what is
// available with thinking clamps, the catalog over a faux model source, and the real layer over a
// fixture agent dir with providers arriving through `ExtraProviders` (registered natively, listed,
// and given D7's compaction override in the run settings).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { FAUX_MODEL, ModelSource } from "../brain/ModelSource.ts";
import { HarnessSettings } from "./HarnessSettings.ts";
import { PiConfig } from "./PiConfig.ts";
import {
  defaultsOf,
  ExtraProviders,
  listing,
  NO_MODEL_DEFAULTS,
  PiModelSource,
} from "./PiModelSource.ts";

const modelsOf = (
  provider: string,
  ids: ReadonlyArray<string>,
  reasoning = true
): ReadonlyArray<Model<Api>> =>
  fauxProvider({
    provider,
    models: ids.map((id) => ({ id, reasoning, input: ["text", "image"] })),
  }).models;

const opencode = modelsOf("opencode-go", ["kimi-k2", "glm-5"]);

const anthropic = modelsOf("anthropic", ["claude-x"]);

const bridge = modelsOf("claude-bridge", ["claude-opus-5-5"]);

const noPi = {
  provider: Option.none<string>(),
  model: Option.none<string>(),
  thinkingLevel: Option.none<"high">(),
};

describe("the picker's listing", () => {
  it("lists available models, extra providers disabled when unavailable, never anthropic", () => {
    const listed = listing(
      { available: [...opencode, ...anthropic], extra: bridge },
      { bridgeEnabled: true }
    );

    assert.deepStrictEqual(
      listed.map((model) => [model.provider, model.modelId, model.available]),
      [
        ["opencode-go", "kimi-k2", true],
        ["opencode-go", "glm-5", true],
        ["claude-bridge", "claude-opus-5-5", false],
      ]
    );
    assert.isTrue(listed[0]?.acceptsImages);
    assert.include(listed[0]?.thinkingLevels ?? [], "medium");
  });

  it("hides the bridge's models when the bridge is off", () => {
    const listed = listing(
      { available: [...opencode, ...bridge], extra: bridge },
      { bridgeEnabled: false }
    );

    assert.isFalse(listed.some((model) => model.provider === "claude-bridge"));
  });

  it("gives a model without reasoning no thinking levels", () => {
    const listed = listing(
      { available: modelsOf("plain", ["small"], false), extra: [] },
      { bridgeEnabled: true }
    );

    assert.deepStrictEqual(listed[0]?.thinkingLevels, []);
  });
});

describe("a new thread's defaults", () => {
  const listed = listing(
    { available: opencode, extra: bridge },
    { bridgeEnabled: true }
  );

  const lookup = () => Option.fromNullishOr(opencode[1]);

  it("takes pi's model when it is available, its level held to the model", () => {
    const defaults = defaultsOf(
      listed,
      {
        provider: Option.some("opencode-go"),
        model: Option.some("glm-5"),
        thinkingLevel: Option.some("high"),
      },
      lookup
    );

    assert.deepStrictEqual(defaults.model, {
      provider: "opencode-go",
      modelId: "glm-5",
    });
    assert.strictEqual(defaults.thinkingLevel, "high");
  });

  it("falls back to the first available model when pi's is not available", () => {
    const defaults = defaultsOf(
      listed,
      {
        provider: Option.some("claude-bridge"),
        model: Option.some("claude-opus-5-5"),
        thinkingLevel: Option.none(),
      },
      lookup
    );

    assert.deepStrictEqual(defaults.model, {
      provider: "opencode-go",
      modelId: "kimi-k2",
    });
    assert.strictEqual(defaults.thinkingLevel, "medium");
  });

  it("keeps pi's model as written, or a fixed one, when nothing is available", () => {
    assert.deepStrictEqual(
      defaultsOf([], noPi, () => Option.none()),
      NO_MODEL_DEFAULTS
    );
  });
});

describe("PiModelSource over a faux model source", () => {
  it.effect("lists the faux model and starts new threads on it", () =>
    Effect.gen(function* () {
      const source = yield* PiModelSource;
      const catalog = yield* source.catalog({ bridgeEnabled: true });

      assert.deepStrictEqual(
        catalog.models.map((model) => [model.provider, model.modelId]),
        [[FAUX_MODEL.provider, FAUX_MODEL.modelId]]
      );
      assert.deepStrictEqual(catalog.defaults.model, FAUX_MODEL);
      // pi-ai's faux models reason up to `high`: a wanted `max` is held there.
      assert.isFalse(catalog.models[0]?.thinkingLevels.includes("max"));
      assert.strictEqual(
        source.thinkingFor(FAUX_MODEL, Option.some("max")),
        "high"
      );
      assert.strictEqual(
        source.thinkingFor(FAUX_MODEL, Option.none()),
        "medium"
      );
    }).pipe(
      Effect.provide(
        PiModelSource.layerFromModelSource.pipe(
          Layer.provide(
            ModelSource.layerFaux({ tokensPerSecond: 1000, settings: {} })
          )
        )
      )
    )
  );
});

describe("PiModelSource over pi's model runtime", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cairn-models-"));
  const agentDir = path.join(root, "agent");
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const dir of [agentDir, home, cwd]) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "claude-bridge",
        defaultModel: "claude-opus-5-5",
      })
    );

    for (const name of ["PI_OFFLINE", "HOME"]) {
      saved.set(name, process.env[name]);
    }

    process.env.PI_OFFLINE = "1";
    process.env.HOME = home;
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
  });

  const signedIn = fauxProvider({
    provider: "claude-bridge",
    models: [{ id: "claude-opus-5-5", reasoning: true }],
  }).provider;

  const signedOut = fauxProvider({
    provider: "other-bridge",
    models: [{ id: "other-1" }],
  }).provider;

  const extras: ReadonlyArray<Provider> = [
    signedIn,
    {
      ...signedOut,
      auth: {
        apiKey: {
          name: "never signed in",
          resolve: async ({ ctx }) => {
            const key = await ctx.env("CAIRN_TEST_NEVER_SET");

            return key === undefined ? key : { auth: { apiKey: key } };
          },
        },
      },
    },
  ];

  const layer = PiModelSource.layerNoDeps.pipe(
    Layer.provide(HarnessSettings.layerNoDeps),
    Layer.provide(
      Layer.suspend(() => PiConfig.layerWith({ agentDir, cwd, home }))
    ),
    Layer.provide(Layer.succeed(ExtraProviders, extras))
  );

  it.live(
    "registers extra providers, lists them and overrides the bridge's compaction",
    () =>
      Effect.gen(function* () {
        const source = yield* PiModelSource;
        const models = yield* ModelSource;

        assert.isDefined(
          models.models().getProvider("claude-bridge"),
          "the extra provider is registered"
        );

        const catalog = yield* source.catalog({ bridgeEnabled: true });

        const listed = catalog.models.map((model) => [
          model.provider,
          model.modelId,
          model.available,
        ]);

        assert.deepInclude(listed, ["claude-bridge", "claude-opus-5-5", true]);
        assert.deepInclude(listed, ["other-bridge", "other-1", false]);
        assert.isFalse(listed.some(([provider]) => provider === "anthropic"));
        assert.deepStrictEqual(catalog.defaults.model, {
          provider: "claude-bridge",
          modelId: "claude-opus-5-5",
        });

        const off = yield* source.catalog({ bridgeEnabled: false });

        assert.isFalse(
          off.models.some((model) => model.provider === "claude-bridge")
        );

        const settings = models.settings();

        assert.strictEqual(settings.afterFailedRun, "keep");
        assert.deepStrictEqual(
          settings.compaction?.modelOverrides?.[
            "claude-bridge/claude-opus-5-5"
          ],
          { backgroundTokens: 0, reserveTokens: 16_384 }
        );

        const statuses = yield* source.providers;

        assert.deepInclude(
          statuses.map((status) => [status.provider, status.state]),
          ["other-bridge", "missing"]
        );
        assert.deepInclude(
          statuses.map((status) => [status.provider, status.state]),
          ["anthropic", "refused"]
        );
      }).pipe(Effect.provide(layer))
  );
});
