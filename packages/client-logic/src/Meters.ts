// What the usage page says, as pure functions (plan wave 6, 6G; models note M10, surfaces note
// S9). One rule runs through all of it: an unknown value is said to be unknown, never
// drawn as zero. A model with no list price reads "no price" with its tokens, a plan window the
// probe could not read reads "unknown", a provider Cairn cannot read (Codex with no login) says so,
// and a thread with no spend recorded is left out rather than listed at $0.00. Dollars are list
// prices (ADR 0036): a plan model's figure is labelled "at API list price", since the plan bills
// nothing per token.

import { Micros } from "@cairn/protocol/Spend";
import type {
  Budget,
  BudgetState,
  ModelSpend,
  Spend,
  SpendSummary,
} from "@cairn/protocol/Spend";
import type { PlanWindow, UsageSnapshot } from "@cairn/protocol/Usage";
import { Array, Match, Option, Order, Result } from "effect";
import type { Record } from "effect";

/** The tone a line takes: a status tone, or neutral for a plain reading. */
export type MeterTone = "neutral" | "working" | "waiting" | "failed" | "done";

/** The bridge's provider id: Claude through the user's Claude Code plan. */
export const BRIDGE_PROVIDER = "claude-bridge";

/** Codex's provider id in pi's catalog. */
export const CODEX_PROVIDER = "openai-codex";

/** OpenCode Go's provider id in pi's catalog. */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** The plans the usage page always has a section for, in order, with the names it shows. */
export const PLAN_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
  [BRIDGE_PROVIDER, "Claude (Claude Code plan)"],
  [CODEX_PROVIDER, "Codex (ChatGPT plan)"],
  [OPENCODE_GO_PROVIDER, "OpenCode Go"],
];

// Money and tokens.

/** Millionths of a dollar as dollars: `$1.23`, `under $0.01` for a priced sliver, `$0.00` for none. */
export const dollarsText = (micros: number): string => {
  if (micros > 0 && micros < 10_000) {
    return "under $0.01";
  }

  return `$${(micros / 1_000_000).toFixed(2)}`;
};

const trimmed = (value: number, digits: number): string =>
  value.toFixed(digits).replace(/\.0+$/u, "");

/** A token count, short: `950`, `12.5k`, `1.2M`. */
export const tokensShort = (tokens: number): string => {
  if (tokens < 1000) {
    return String(tokens);
  }

  if (tokens < 1_000_000) {
    return `${trimmed(tokens / 1000, tokens < 100_000 ? 1 : 0)}k`;
  }

  return `${trimmed(tokens / 1_000_000, 1)}M`;
};

/** A token count with its unit: `1 token`, `12.5k tokens`. */
export const tokensText = (tokens: number): string =>
  tokens === 1 ? "1 token" : `${tokensShort(tokens)} tokens`;

/** Every token of a `Spend`'s counts. */
export const totalTokensOf = (tokens: Spend["tokens"]): number =>
  tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;

/**
 * What a scope spent, in words: priced tokens as list-price dollars, unpriced ones as tokens with
 * no price. A scope that spent only unpriced tokens has no dollar figure at all; one that spent
 * nothing says so (a known zero, not an unknown).
 */
export interface SpendFigure {
  /** The dollar figure, none when nothing it spent has a price. */
  readonly dollars: Option.Option<string>;
  /** The tokens no price covers, none when every token is priced. */
  readonly unpriced: Option.Option<string>;
  /** The whole figure as one line. */
  readonly text: string;
  /** Whether anything was spent. */
  readonly spent: boolean;
}

/** The figure for `total` tokens of which `unpricedTokens` have no price, priced at `listMicros`. */
export const spendFigure = (input: {
  readonly totalTokens: number;
  readonly listMicros: number;
  readonly unpricedTokens: number;
}): SpendFigure => {
  if (input.totalTokens === 0 && input.listMicros === 0) {
    return {
      dollars: Option.none(),
      unpriced: Option.none(),
      text: "Nothing spent yet",
      spent: false,
    };
  }

  const pricedTokens = Math.max(0, input.totalTokens - input.unpricedTokens);

  const dollars =
    pricedTokens > 0 || input.listMicros > 0
      ? Option.some(`${dollarsText(input.listMicros)} at list price`)
      : Option.none();

  const unpriced =
    input.unpricedTokens > 0
      ? Option.some(`${tokensText(input.unpricedTokens)} with no price`)
      : Option.none();

  const text = Option.match(dollars, {
    onNone: () =>
      `No price: ${tokensText(input.unpricedTokens)} with no list price`,
    onSome: (figure) =>
      Option.match(unpriced, {
        onNone: () => figure,
        onSome: (tokens) => `${figure}, plus ${tokens}`,
      }),
  });

  return { dollars, unpriced, text, spent: true };
};

/** The figure of a whole roll-up (`spend.get`). */
export const spendFigureOf = (spend: Spend): SpendFigure =>
  spendFigure({
    totalTokens: totalTokensOf(spend.tokens),
    listMicros: spend.listMicros,
    unpricedTokens: spend.unpricedTokens,
  });

/** The figure of a thread row's summary. */
export const summaryFigureOf = (summary: SpendSummary): SpendFigure =>
  spendFigure({
    totalTokens: summary.totalTokens,
    listMicros: summary.listMicros,
    unpricedTokens: summary.unpricedTokens,
  });

/** One model's line in the ledger. */
export interface ModelLine {
  /** `provider/modelId`. */
  readonly model: string;
  readonly tokens: string;
  /** The dollar figure with its basis, or "No price". */
  readonly price: string;
  /** False when the model has no price: its line must not read as a dollar amount. */
  readonly priced: boolean;
}

const basisWords = (spend: ModelSpend): string =>
  spend.basis === "list_on_plan"
    ? "at API list price (plan, not billed)"
    : "billed at list price";

/** A model's line: tokens, and dollars with their basis, or no price. */
export const modelLineOf = (model: string, spend: ModelSpend): ModelLine => {
  const price =
    spend.basis === "unpriced" ? Option.none<number>() : spend.listMicros;

  return {
    model,
    tokens: tokensText(totalTokensOf(spend.tokens)),
    price: Option.match(price, {
      onNone: () => "No price",
      onSome: (micros) => `${dollarsText(micros)} ${basisWords(spend)}`,
    }),
    priced: Option.isSome(price),
  };
};

const byMostTokens = Order.mapInput(
  Order.flip(Order.Number),
  ([, spend]: readonly [string, ModelSpend]) => totalTokensOf(spend.tokens)
);

/** Every model's line of a roll-up, the most tokens first. */
export const modelLinesOf = (spend: Spend): ReadonlyArray<ModelLine> =>
  Array.sort(Object.entries(spend.byModel), byMostTokens).map(([model, each]) =>
    modelLineOf(model, each)
  );

// Budgets.

/** A budget state's words and tone. */
export interface BudgetWord {
  readonly word: string;
  readonly tone: MeterTone;
}

const BUDGET_WORDS: Readonly<Record<BudgetState, Option.Option<BudgetWord>>> = {
  none: Option.none(),
  within: Option.some({ word: "Within budget", tone: "working" }),
  warned: Option.some({ word: "Past its warning line", tone: "waiting" }),
  exhausted: Option.some({
    word: "Budget reached: new work stopped",
    tone: "failed",
  }),
};

/** A budget state in words, with its tone; none for a thread without a budget. */
export const budgetWordOf = (state: BudgetState): Option.Option<BudgetWord> =>
  BUDGET_WORDS[state];

/** A limit's words: "No limit" when the budget sets none. */
const limitText = <A>(value: A | null, text: (found: A) => string): string =>
  value === null ? "No limit" : text(value);

/**
 * A budget's limits as label and value pairs; an absent limit reads "No limit", never zero. Only
 * dollars and tokens are offered (ADR 0047): nothing sets turns, minutes or a plan-window guard, so
 * no line shows them.
 */
export const budgetLinesOf = (
  budget: Budget
): ReadonlyArray<readonly [string, string]> => [
  [
    "Dollars",
    limitText(
      budget.maxListMicros,
      (micros) => `${dollarsText(micros)} at list price`
    ),
  ],
  ["Tokens", limitText(budget.maxTokens, tokensText)],
  ["Warns at", `${String(Math.round(budget.warnAt * 100))}% of a limit`],
];

// Budget fields (ADR 0047): the usage page's default and thread budgets, and a Go card's budget,
// typed in dollars at list price and tokens, each empty for no limit.

/** A budget field's text as typed: dollars at list price and tokens, each empty for no limit. */
export interface BudgetDraft {
  readonly dollars: string;
  readonly tokens: string;
}

/** The field's starting text for `budget`. */
export const budgetDraftOf = (budget: Budget): BudgetDraft => ({
  dollars:
    budget.maxListMicros === null
      ? ""
      : (budget.maxListMicros / 1_000_000).toFixed(2),
  tokens: budget.maxTokens === null ? "" : String(budget.maxTokens),
});

/** A dollar field: list-price micros, none when empty, or why it is not a limit. */
const dollarsOfDraft = (text: string): Result.Result<number | null, string> => {
  const plain = text.trim().replace(/^\$/u, "").replaceAll(",", "").trim();

  if (plain === "") {
    return Result.succeed(null);
  }

  const dollars = /^\d+(?:\.\d+)?$/u.test(plain) ? Number(plain) : Number.NaN;
  const micros = Math.round(dollars * 1_000_000);

  return Number.isFinite(dollars) && micros > 0
    ? Result.succeed(micros)
    : Result.fail(
        "Dollars must be an amount above zero, like 2.50, or empty for no dollar limit."
      );
};

/** A token field: a whole count, none when empty, or why it is not a limit. */
const tokensOfDraft = (text: string): Result.Result<number | null, string> => {
  const plain = text.trim().replaceAll(/[,_\s]/gu, "");

  if (plain === "") {
    return Result.succeed(null);
  }

  const tokens = /^\d+$/u.test(plain) ? Number(plain) : Number.NaN;

  return Number.isSafeInteger(tokens) && tokens > 0
    ? Result.succeed(tokens)
    : Result.fail(
        "Tokens must be a whole number above zero, like 200000, or empty for no token limit."
      );
};

/**
 * `base` with the dollar and token limits a budget field says (both empty is no limit), or why a
 * field is not a limit. Its warning line is `base`'s.
 */
export const budgetOfDraft = (
  base: Budget,
  draft: BudgetDraft
): Result.Result<Budget, string> =>
  Result.flatMap(dollarsOfDraft(draft.dollars), (micros) =>
    Result.map(tokensOfDraft(draft.tokens), (tokens) => ({
      ...base,
      maxListMicros: micros === null ? null : Micros.make(micros),
      maxTokens: tokens,
    }))
  );

/**
 * The budget Go sends for `proposed` with the field's `draft`: none when the field is closed or
 * says what was proposed, the changed budget otherwise (both fields empty is no limit), or why a
 * field is not a limit.
 */
export const budgetEditOf = (
  proposed: Budget,
  draft: Option.Option<BudgetDraft>
): Result.Result<Option.Option<Budget>, string> =>
  Option.match(draft, {
    onNone: () => Result.succeed(Option.none()),
    onSome: (typed) =>
      Result.map(budgetOfDraft(proposed, typed), (edited) =>
        edited.maxListMicros === proposed.maxListMicros &&
        edited.maxTokens === proposed.maxTokens
          ? Option.none()
          : Option.some(edited)
      ),
  });

// Plan windows.

/** The share a window has used, as a percent, or none while unknown; a spent window is full. */
export const windowPercentOf = (window: PlanWindow): Option.Option<number> =>
  window.exhausted
    ? Option.some(100)
    : Option.map(window.used, (used) => Math.round(used * 100));

/** What a plan's section shows. */
export type PlanState =
  /** No frame of `usage.subscribe` yet: nothing is known. */
  | { readonly kind: "waiting" }
  /** The brain holds no reading for this plan; the words say why. */
  | { readonly kind: "absent"; readonly why: string }
  /** The provider's reading failed or changed shape: its windows are unknown. */
  | { readonly kind: "unreadable" }
  /** The plan publishes no windows Cairn can read. */
  | { readonly kind: "unsupported" }
  /** Read: its windows, possibly none. */
  | { readonly kind: "read"; readonly windows: ReadonlyArray<PlanWindow> };

const ABSENT_WHY: Readonly<Record<string, string>> = {
  [BRIDGE_PROVIDER]:
    "The Claude bridge is off or not signed in, so its windows are not read.",
  [CODEX_PROVIDER]:
    "Not signed in: there is no Codex subscription, so Cairn reads no Codex windows.",
  [OPENCODE_GO_PROVIDER]: "OpenCode Go is not set up on this machine.",
};

/** The section of `provider` in `usage`. */
export const planStateOf = (
  usage: Option.Option<UsageSnapshot>,
  provider: string
): PlanState =>
  Option.match(usage, {
    onNone: (): PlanState => ({ kind: "waiting" }),
    onSome: (snapshot): PlanState =>
      Option.match(
        Array.findFirst(snapshot.providers, (row) => row.provider === provider),
        {
          onNone: (): PlanState => ({
            kind: "absent",
            why:
              ABSENT_WHY[provider] ??
              "The brain holds no reading for this provider.",
          }),
          onSome: (row): PlanState =>
            Match.value(row.reading).pipe(
              Match.when("read", (): PlanState => ({
                kind: "read",
                windows: row.windows,
              })),
              Match.when("unreadable", (): PlanState => ({
                kind: "unreadable",
              })),
              Match.when("unsupported", (): PlanState => ({
                kind: "unsupported",
              })),
              Match.exhaustive
            ),
        }
      ),
  });

/** The providers the snapshot reads beyond the fixed plans, in its order. */
export const otherPlanProviders = (
  usage: Option.Option<UsageSnapshot>
): ReadonlyArray<string> =>
  Option.match(usage, {
    onNone: () => [],
    onSome: (snapshot) =>
      snapshot.providers
        .map((row) => row.provider)
        .filter((id) => !PLAN_PROVIDERS.some(([fixed]) => fixed === id)),
  });
