// Pricing (ADR 0036): tiers apply by a request's whole input as pi-ai prices them, a bridge model is
// priced as its `anthropic` twin and labelled at API list price, plan providers are `list_on_plan`
// and keyed ones `metered`, and a model whose rates are all zero, or that the catalog lacks, is
// unpriced: no figure at all, never $0. The catalog rows are copied from pi-ai 1.4.0's
// `providers/data/*.json`, and one test reads the runtime catalog with the guarded anthropic provider,
// as the brain registers it; pi-ai's own `calculateCost` is the outside judge of the arithmetic.

import { claudeModels, DEFAULT_LONG_CONTEXT } from "@cairn/bridge/ClaudeModels";
import type { Usage } from "@earendil-works/pi-ai";
import { calculateCost, fauxProvider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { guardedAnthropicProvider } from "./AnthropicGuard.ts";
import type { CatalogEntry, CatalogLookup, TokenUse } from "./ModelPrice.ts";
import {
  basisOf,
  catalogLookupOf,
  listMicrosOf,
  ModelPrice,
  priceBasisOf,
  priceLabel,
  priceOf,
} from "./ModelPrice.ts";

const ref = (provider: string, modelId: string) => ({ provider, modelId });

const haikuCost = {
  input: 0.1,
  output: 0.5,
  cacheRead: 0.01,
  cacheWrite: 0.125,
  tiers: [
    {
      inputTokensAbove: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    },
  ],
};

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** A slice of pi-ai's catalog, keyed `provider/modelId`. */
const CATALOG = {
  "anthropic/claude-haiku-5-5": { cost: haikuCost },
  "anthropic/claude-opus-5-5": {
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  },
  // The bridge registers its models at zero (`packages/bridge/src/ClaudeModels.ts`).
  "claude-bridge/claude-haiku-5-5": { cost: zero },
  "claude-bridge/claude-opus-5-5": { cost: zero },
  "claude-bridge/claude-unlisted-9": { cost: zero },
  "opencode-go/claude-haiku-5-5": { cost: haikuCost },
  "opencode-go/beam-free": { cost: zero },
  "opencode-go/qwen3.8-flash": {
    cost: { input: 0.15, output: 0.47, cacheRead: 0.016, cacheWrite: 0.2 },
  },
  "openai-codex/gpt-6-luna": {
    cost: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite: 0.125,
      tiers: [
        {
          inputTokensAbove: 272_000,
          input: 0.2,
          output: 0.75,
          cacheRead: 0.02,
          cacheWrite: 0.25,
        },
      ],
    },
  },
  "openrouter/deepseek/deepseek-v4-pro": {
    cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
  },
  // Zero base rates with a priced tier still has a price.
  "openrouter/odd/tier-only": {
    cost: {
      ...zero,
      tiers: [{ inputTokensAbove: 1000, ...zero, input: 1 }],
    },
  },
} satisfies Record<string, CatalogEntry>;

const ENTRIES: ReadonlyMap<string, CatalogEntry> = new Map(
  Object.entries(CATALOG)
);

const lookup: CatalogLookup = (model) =>
  Option.fromUndefinedOr(ENTRIES.get(`${model.provider}/${model.modelId}`));

const use = (partial: Partial<TokenUse>): TokenUse => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWrite1h: 0,
  ...partial,
});

/** pi-ai's own figure for `tokens` at `cost`, in micros. */
const piMicros = (cost: CatalogEntry["cost"], tokens: TokenUse) => {
  const faux = fauxProvider({ provider: "judge", models: [{ id: "m" }] });

  const usage: Usage = {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    cacheWrite1h: tokens.cacheWrite1h,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  return Math.round(
    calculateCost({ ...faux.getModel(), cost }, usage).total * 1_000_000
  );
};

const micros = (provider: string, modelId: string, tokens: TokenUse) =>
  listMicrosOf(priceOf(ref(provider, modelId), lookup), tokens);

describe("model prices", () => {
  it("prices a response at the base rates below the first tier", () => {
    // 10k in at $0.1, 2k out at $0.5, per Mtok: 1,000 + 1,000 micros.
    const tokens = use({ input: 10_000, output: 2000 });

    assert.deepStrictEqual(
      micros("opencode-go", "claude-haiku-5-5", tokens),
      Option.some(2000)
    );
    assert.strictEqual(piMicros(haikuCost, tokens), 2000);
  });

  it("switches to a tier by the whole input, cache reads and writes included", () => {
    // 60k fresh + 50k cache read = 110k input, over the 100k tier: $0.5 in, $2.5 out, $0.05 read.
    const tokens = use({ input: 60_000, cacheRead: 50_000, output: 1000 });
    // 0.5 × 60,000 + 0.05 × 50,000 + 2.5 × 1,000
    const expected = 35_000;

    assert.deepStrictEqual(
      micros("opencode-go", "claude-haiku-5-5", tokens),
      Option.some(expected)
    );
    assert.strictEqual(piMicros(haikuCost, tokens), expected);

    // Exactly at the threshold is not above it.
    const atLine = use({ input: 100_000 });

    assert.deepStrictEqual(
      micros("opencode-go", "claude-haiku-5-5", atLine),
      Option.some(10_000)
    );
  });

  it("charges a one-hour cache write at twice the input rate", () => {
    const tokens = use({ input: 1000, cacheWrite: 3000, cacheWrite1h: 1000 });
    // 4 × 1,000 in + 5 × 2,000 five-minute writes + 8 × 1,000 one-hour writes
    const expected = 22_000;

    assert.deepStrictEqual(
      micros("claude-bridge", "claude-opus-5-5", tokens),
      Option.some(expected)
    );
    assert.strictEqual(
      piMicros({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, tokens),
      expected
    );
  });

  it("agrees with pi-ai over a spread of responses on every priced model", () => {
    const spread = [
      use({ input: 1, output: 1 }),
      use({ input: 12_345, output: 6789, cacheRead: 4321 }),
      use({ input: 250_000, cacheRead: 30_000, output: 9000 }),
      use({ input: 300_000, cacheWrite: 20_000, cacheWrite1h: 5000 }),
    ];

    for (const [key, entry] of Object.entries(CATALOG)) {
      const slash = key.indexOf("/");
      const model = ref(key.slice(0, slash), key.slice(slash + 1));

      if (model.provider === "claude-bridge") {
        continue;
      }

      for (const tokens of spread) {
        const ours = listMicrosOf(priceOf(model, lookup), tokens);

        if (Option.isSome(ours)) {
          assert.strictEqual(ours.value, piMicros(entry.cost, tokens), key);
        }
      }
    }
  });

  it("prices a bridge model as its anthropic twin, labelled at API list price", () => {
    const price = priceOf(ref("claude-bridge", "claude-opus-5-5"), lookup);

    assert.isTrue(ModelPrice.$is("Priced")(price));
    assert.strictEqual(priceBasisOf(price), "list_on_plan");
    assert.strictEqual(
      priceLabel(price),
      "$4 in, $20 out per Mtok at API list price"
    );

    assert.deepStrictEqual(
      ModelPrice.$match(price, {
        Priced: ({ ratesOf }) => Option.some(ratesOf),
        Unpriced: () => Option.none(),
      }),
      Option.some(ref("anthropic", "claude-opus-5-5"))
    );

    // The twin's tiers come along.
    assert.deepStrictEqual(
      micros("claude-bridge", "claude-haiku-5-5", use({ input: 200_000 })),
      Option.some(100_000)
    );
  });

  it("leaves a bridge model unpriced when its twin is not in the catalog", () => {
    const price = priceOf(ref("claude-bridge", "claude-unlisted-9"), lookup);

    assert.deepStrictEqual(
      price,
      ModelPrice.Unpriced({ reason: "not_in_catalog" })
    );
  });

  it("treats an all-zero price as unpriced, never as zero dollars", () => {
    const price = priceOf(ref("opencode-go", "beam-free"), lookup);

    assert.deepStrictEqual(
      price,
      ModelPrice.Unpriced({ reason: "no_price_listed" })
    );
    assert.strictEqual(priceBasisOf(price), "unpriced");
    assert.strictEqual(priceLabel(price), "no price listed");
    assert.isTrue(
      Option.isNone(
        listMicrosOf(price, use({ input: 1_000_000, output: 1_000_000 }))
      )
    );
    assert.notInclude(priceLabel(price), "$");
  });

  it("keeps a price whose only nonzero rates are in a tier", () => {
    const price = priceOf(ref("openrouter", "odd/tier-only"), lookup);

    assert.isTrue(ModelPrice.$is("Priced")(price));
    assert.strictEqual(priceLabel(price), "<$0.0001 in, <$0.0001 out per Mtok");
    assert.deepStrictEqual(
      listMicrosOf(price, use({ input: 500 })),
      Option.some(0)
    );
    assert.deepStrictEqual(
      listMicrosOf(price, use({ input: 2000 })),
      Option.some(2000)
    );
  });

  it("leaves a model the catalog does not list unpriced", () => {
    assert.deepStrictEqual(
      priceOf(ref("opencode-go", "not-a-model"), lookup),
      ModelPrice.Unpriced({ reason: "not_in_catalog" })
    );
  });

  it("labels plan providers list_on_plan and keyed providers metered", () => {
    const table: ReadonlyArray<readonly [string, string]> = [
      ["claude-bridge", "list_on_plan"],
      ["opencode-go", "list_on_plan"],
      ["openai-codex", "list_on_plan"],
      ["qwen-token-plan", "list_on_plan"],
      ["xiaomi-token-plan-sgp", "list_on_plan"],
      ["openrouter", "metered"],
      ["openai", "metered"],
      ["anthropic", "metered"],
      ["deepseek", "metered"],
    ];

    for (const [provider, basis] of table) {
      assert.strictEqual(basisOf(provider), basis, provider);
    }

    assert.strictEqual(
      priceLabel(
        priceOf(ref("openrouter", "deepseek/deepseek-v4-pro"), lookup)
      ),
      "$1.74 in, $3.48 out per Mtok"
    );
    assert.strictEqual(
      priceLabel(priceOf(ref("openai-codex", "gpt-6-luna"), lookup)),
      "$0.1 in, $0.5 out per Mtok at API list price"
    );
  });

  it("prices every bridge model from the runtime's own anthropic catalog", () => {
    const models = createModels();

    models.setProvider(guardedAnthropicProvider());

    const runtime = catalogLookupOf(models);
    const opus = priceOf(ref("claude-bridge", "claude-opus-5-5"), runtime);

    assert.strictEqual(
      priceLabel(opus),
      "$4 in, $20 out per Mtok at API list price"
    );

    for (const model of claudeModels(DEFAULT_LONG_CONTEXT)) {
      assert.isTrue(
        ModelPrice.$is("Priced")(
          priceOf(ref(model.provider, model.id), runtime)
        ),
        model.id
      );
    }
  });
});
