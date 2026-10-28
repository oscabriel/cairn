// A model's list price and what it means (ADR 0036). pi-ai's catalog gives each model its rates in
// dollars per million tokens, with tiers above an input size; a figure computed from them is a list
// price, not a bill, unless the provider bills per token. The Claude bridge registers its models at
// zero (the plan is the meter), so a bridge model borrows the rates of the `anthropic` catalog entry
// with the same id and is labelled as an equivalent at API list price. A model whose rates are all
// zero, or that is not in the catalog, is unpriced: it counts tokens only and is never shown as $0.
//
// Pure over a catalog lookup, so the spend ledger, the role check and their tests share one rule.
// The arithmetic matches pi-ai's `calculateCost` (`models.ts`): the tier with the highest threshold
// below the request's whole input (fresh, cache read and cache write) wins, and a one-hour cache
// write costs twice the base input rate.

import type { ModelRef } from "@cairn/protocol/Models";
import type { PriceBasis } from "@cairn/protocol/Spend";
import { Micros } from "@cairn/protocol/Spend";
import type { Model, Models } from "@earendil-works/pi-ai";
import { Data, Option } from "effect";

/** Dollars per million tokens of each kind. */
export interface PriceRates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Rates that replace the base rates when a request's whole input is above `inputTokensAbove`. */
export interface PriceTier extends PriceRates {
  readonly inputTokensAbove: number;
}

/** A model's price, or why it has none. */
export type ModelPrice = Data.TaggedEnum<{
  Priced: {
    /** A plan's catalog price (`list_on_plan`) or a per-token bill (`metered`). */
    readonly basis: Exclude<PriceBasis, "unpriced">;
    readonly rates: PriceRates;
    /** Ascending by threshold. */
    readonly tiers: ReadonlyArray<PriceTier>;
    /**
     * The catalog entry the rates come from: the model itself, or for a bridge model the
     * `anthropic` entry of the same id (the labelled equivalent).
     */
    readonly ratesOf: ModelRef;
  };
  Unpriced: {
    /** `not_in_catalog`: no entry to read; `no_price_listed`: every rate is zero. */
    readonly reason: "not_in_catalog" | "no_price_listed";
  };
}>;

/** Builds and matches `ModelPrice` values. */
export const ModelPrice = Data.taggedEnum<ModelPrice>();

/** The catalog fields a price is read from. */
export type CatalogEntry = Pick<Model<string>, "cost">;

/** Finds a model's catalog entry; none when the catalog does not list it. */
export type CatalogLookup = (model: ModelRef) => Option.Option<CatalogEntry>;

/** The bridge's provider id (`packages/bridge`); its models are on the Claude plan. */
const BRIDGE_PROVIDER = "claude-bridge";

/** Where a bridge model's labelled equivalent is read from. */
const BRIDGE_RATES_PROVIDER = "anthropic";

/**
 * Providers that sell a plan rather than tokens: a dollar figure on them is the catalog price of
 * what was used, not a bill. Every other provider with a key is billed per token.
 */
const PLAN_PROVIDERS: ReadonlySet<string> = new Set([
  BRIDGE_PROVIDER,
  "opencode-go",
  "openai-codex",
  "github-copilot",
  "kimi-coding",
  "zai-coding-cn",
]);

/** pi's token-plan providers (`qwen-token-plan`, `xiaomi-token-plan-sgp`, ...). */
const TOKEN_PLAN = /-token-plan(?:-|$)/u;

/** How a provider's dollar figure relates to a bill, before knowing whether the model is priced. */
export const basisOf = (provider: string): Exclude<PriceBasis, "unpriced"> =>
  PLAN_PROVIDERS.has(provider) || TOKEN_PLAN.test(provider)
    ? "list_on_plan"
    : "metered";

/** The catalog lookup over pi's model runtime. */
export const catalogLookupOf =
  (models: Pick<Models, "getModel">): CatalogLookup =>
  (model) =>
    Option.fromUndefinedOr(models.getModel(model.provider, model.modelId));

const isZero = (rates: PriceRates) =>
  rates.input === 0 &&
  rates.output === 0 &&
  rates.cacheRead === 0 &&
  rates.cacheWrite === 0;

const ratesOnly = (rates: PriceRates): PriceRates => ({
  input: rates.input,
  output: rates.output,
  cacheRead: rates.cacheRead,
  cacheWrite: rates.cacheWrite,
});

/**
 * A model's price. A bridge model's rates are its `anthropic` twin's, labelled `list_on_plan`; a
 * model with no catalog entry or with every rate (tiers included) at zero is `Unpriced`.
 */
export const priceOf = (model: ModelRef, lookup: CatalogLookup): ModelPrice => {
  const ratesOf =
    model.provider === BRIDGE_PROVIDER
      ? { provider: BRIDGE_RATES_PROVIDER, modelId: model.modelId }
      : model;

  const entry = lookup(ratesOf);

  if (Option.isNone(entry)) {
    return ModelPrice.Unpriced({ reason: "not_in_catalog" });
  }

  const { cost } = entry.value;

  const tiers = (cost.tiers ?? [])
    .map((tier) => ({
      ...ratesOnly(tier),
      inputTokensAbove: tier.inputTokensAbove,
    }))
    .toSorted((a, b) => a.inputTokensAbove - b.inputTokensAbove);

  if (isZero(cost) && tiers.every(isZero)) {
    return ModelPrice.Unpriced({ reason: "no_price_listed" });
  }

  return ModelPrice.Priced({
    basis: basisOf(model.provider),
    rates: ratesOnly(cost),
    tiers,
    ratesOf,
  });
};

/** The price basis a spend row records for a model. */
export const priceBasisOf = (price: ModelPrice): PriceBasis =>
  ModelPrice.$match(price, {
    Priced: ({ basis }) => basis,
    Unpriced: (): PriceBasis => "unpriced",
  });

/** Token counts of one response or a sum of them, as pi-ai's `Usage` records them. */
export interface TokenUse {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** Every cache write, the one-hour ones included. */
  readonly cacheWrite: number;
  /** The part of `cacheWrite` written with one-hour retention (Anthropic only), at twice input. */
  readonly cacheWrite1h: number;
}

/** A price that has rates. */
export type PricedModel = Data.TaggedEnum.Value<ModelPrice, "Priced">;

/** The rates that apply to a request with `inputTokens` of input: the highest tier it passes. */
export const ratesFor = (
  price: PricedModel,
  inputTokens: number
): PriceRates => {
  let { rates } = price;

  for (const tier of price.tiers) {
    if (inputTokens > tier.inputTokensAbove) {
      rates = tier;
    }
  }

  return rates;
};

/** `use` at a priced model's rates, in micros. */
const microsAt = (price: PricedModel, use: TokenUse): Micros => {
  const rates = ratesFor(price, use.input + use.cacheRead + use.cacheWrite);
  const shortWrite = use.cacheWrite - use.cacheWrite1h;

  // Dollars per million tokens times tokens is millionths of a dollar.
  const micros =
    rates.input * use.input +
    rates.output * use.output +
    rates.cacheRead * use.cacheRead +
    rates.cacheWrite * shortWrite +
    rates.input * 2 * use.cacheWrite1h;

  return Micros.make(Math.round(micros));
};

/**
 * The list price of `use`, in millionths of a dollar, rounded; none when the model is unpriced, so
 * unknown never adds up as zero. Tiers apply per request: price each response, then sum.
 */
export const listMicrosOf = (
  price: ModelPrice,
  use: TokenUse
): Option.Option<Micros> =>
  ModelPrice.$match(price, {
    Priced: (priced) => Option.some(microsAt(priced, use)),
    Unpriced: () => Option.none(),
  });

const dollars = (perMtok: number) =>
  `$${perMtok.toFixed(4).replace(/\.?0+$/u, "")}`;

/**
 * How a price reads on a card or in the `roles` tool: input and output per million tokens, with
 * "at API list price" on a plan, or "no price listed". Never "$0".
 */
export const priceLabel = (price: ModelPrice): string =>
  ModelPrice.$match(price, {
    Priced: ({ basis, rates }) =>
      `${dollars(rates.input)} in, ${dollars(rates.output)} out per Mtok${
        basis === "list_on_plan" ? " at API list price" : ""
      }`,
    Unpriced: () => "no price listed",
  });
