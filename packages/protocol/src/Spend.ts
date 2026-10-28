// Spend and budgets (ADR 0036). Spend is derived from each conversation's `pi.usage` document, so
// a `kill -9` cannot double count. Dollar figures are list prices, labelled as such unless a
// provider is metered, kept in millionths of a dollar; a model without a price counts tokens only
// and is shown as unpriced, never as zero. Shapes from docs/phase-2/notes/models.md, sections 3
// and 4.

import { Schema } from "effect";

import {
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./Ids.ts";

/** Millionths of a US dollar: integers, so sums never drift. */
export const Micros = NonNegativeInt.pipe(Schema.brand("Micros"));

export type Micros = typeof Micros.Type;

/** How a provider's dollar figure relates to a bill. */
export const PriceBasis = Schema.Literals([
  /** A plan (the bridge, OpenCode Go, Codex): the figure is the catalog price, not a bill. */
  "list_on_plan",
  /** Billed per token at the catalog price. */
  "metered",
  /** No price listed: tokens only. */
  "unpriced",
]);

export type PriceBasis = typeof PriceBasis.Type;

/** Token counts of one model, summed. `reasoning` is none where the provider does not report it. */
export const Tokens = Schema.Struct({
  input: NonNegativeInt,
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  cacheWrite: NonNegativeInt,
  reasoning: Schema.OptionFromNullOr(NonNegativeInt),
});

export type Tokens = typeof Tokens.Type;

/** One model's share of a spend: its tokens, and their list price when it has one. */
export const ModelSpend = Schema.Struct({
  tokens: Tokens,
  /** None when the model is unpriced. */
  listMicros: Schema.OptionFromNullOr(Micros),
  basis: PriceBasis,
});

export type ModelSpend = typeof ModelSpend.Type;

/**
 * What a scope spent. `listMicros` sums priced models only; `unpricedTokens` is what it leaves
 * out, so "at least $0.42, plus 120k tokens with no price" can be said and unknown is never zero.
 */
export const Spend = Schema.Struct({
  tokens: Tokens,
  listMicros: Micros,
  unpricedTokens: NonNegativeInt,
  unpricedModels: Schema.Array(TrimmedNonEmptyString),
  /** Keyed `provider/modelId`. */
  byModel: Schema.Record(Schema.String, ModelSpend),
  /** A stone's compute (phase 3); none on the host. */
  compute: Schema.OptionFromNullOr(
    Schema.Struct({ seconds: NonNegativeInt, micros: Micros })
  ),
});

export type Spend = typeof Spend.Type;

/**
 * Where a thread's budget stands: none set, under its warning line, past it, or reached (the guard
 * stopped new work).
 */
export const BudgetState = Schema.Literals([
  "none",
  "within",
  "warned",
  "exhausted",
]);

export type BudgetState = typeof BudgetState.Type;

/** The coarse spend a thread row carries on the shell stream: its own and its lineage subtree's. */
export const SpendSummary = Schema.Struct({
  totalTokens: NonNegativeInt,
  listMicros: Micros,
  unpricedTokens: NonNegativeInt,
  budget: BudgetState,
});

export type SpendSummary = typeof SpendSummary.Type;

/** What a spend roll-up covers. */
export const SpendScope = Schema.Union([
  /** A thread and its lineage subtree. */
  Schema.TaggedStruct("Thread", { threadId: ThreadId }),
  /** A goal thread, its subagents and their children. */
  Schema.TaggedStruct("Goal", { threadId: ThreadId }),
  /** One workflow run's nodes. */
  Schema.TaggedStruct("WorkflowRun", {
    threadId: ThreadId,
    workflowId: TrimmedNonEmptyString,
  }),
  /** Everything the brain recorded, calls outside conversations included. */
  Schema.TaggedStruct("All", {}),
]);

export type SpendScope = typeof SpendScope.Type;

/** `spend.get` input. */
export const SpendGetInput = Schema.Struct({
  scope: SpendScope,
});

export type SpendGetInput = typeof SpendGetInput.Type;

/** A guard on a plan window: stop new work above a used fraction of that window. */
export const PlanGuard = Schema.Struct({
  provider: TrimmedNonEmptyString,
  windowId: TrimmedNonEmptyString,
  maxUsedFraction: Schema.Finite.check(
    Schema.isBetween({ minimum: 0, maximum: 1 })
  ),
});

export type PlanGuard = typeof PlanGuard.Type;

/**
 * A budget, carried by a brief and by a workflow's launch approval; the approval document is the
 * authority. A dollar limit binds priced tokens only, so a plan-billed role is bound by `maxTokens`
 * and `planGuard`. Overshoot is at most one response per running child. Plain JSON: it lives in
 * documents.
 */
export const Budget = Schema.Struct({
  maxListMicros: Schema.NullOr(Micros),
  maxTokens: Schema.NullOr(PositiveInt),
  maxTurns: Schema.NullOr(PositiveInt),
  maxMinutes: Schema.NullOr(PositiveInt),
  planGuard: Schema.NullOr(PlanGuard),
  /** The fraction at which a warning fires once; 0.8 by default. */
  warnAt: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});

export type Budget = typeof Budget.Type;

/** The budget a brief or launch carries when it names none. */
export const DEFAULT_BUDGET: Budget = {
  maxListMicros: null,
  maxTokens: null,
  maxTurns: null,
  maxMinutes: null,
  planGuard: null,
  warnAt: 0.8,
};
