// What the usage page and the role table say, as pure functions (plan wave 6, 6G; models note M10,
// surfaces note S9). One rule runs through all of it: an unknown value is said to be unknown, never
// drawn as zero. A model with no list price reads "no price" with its tokens, a plan window the
// probe could not read reads "unknown", a provider Cairn cannot read (Codex with no login) says so,
// and a thread with no spend recorded is left out rather than listed at $0.00. Dollars are list
// prices (ADR 0036): a plan model's figure is labelled "at API list price", since the plan bills
// nothing per token.

import type {
  ModelListing,
  ModelRef,
  ThinkingLevel,
} from "@cairn/protocol/Models";
import type {
  RoleBinding,
  RoleCheck,
  RoleName,
  RoleTable,
  SkippedModel,
} from "@cairn/protocol/Roles";
import { BUILT_IN_ROLES } from "@cairn/protocol/Roles";
import type {
  Budget,
  BudgetState,
  ModelSpend,
  Spend,
  SpendSummary,
} from "@cairn/protocol/Spend";
import type { PlanWindow, UsageSnapshot } from "@cairn/protocol/Usage";
import { Array, Match, Option, Order, Record } from "effect";

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

/** A budget's limits as label and value pairs; an absent limit reads "No limit", never zero. */
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
  ["Turns", limitText(budget.maxTurns, String)],
  ["Minutes", limitText(budget.maxMinutes, String)],
  [
    "Plan guard",
    limitText(
      budget.planGuard,
      (guard) =>
        `${guard.provider} ${guard.windowId} up to ${String(Math.round(guard.maxUsedFraction * 100))}%`
    ),
  ],
  ["Warns at", `${String(Math.round(budget.warnAt * 100))}% of a limit`],
];

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

// The role table.

/** A role's binding as text: `claude-bridge/claude-opus-5-5 at medium`. */
export const modelText = (model: ModelRef): string =>
  `${model.provider}/${model.modelId}`;

/** The roles of a table in the order the editor lists them: built-ins first, then by name. */
export const rolesOf = (table: RoleTable): ReadonlyArray<RoleName> => {
  const names = Record.keys(table);

  const builtIn = BUILT_IN_ROLES.flatMap((role) =>
    names.filter((name) => name === role)
  );

  return [
    ...builtIn,
    ...names.filter((name) => !BUILT_IN_ROLES.includes(name)).toSorted(),
  ];
};

const SKIP_WORDS: Readonly<Record<SkippedModel["reason"], string>> = {
  missing_credential: "has no credential here",
  unknown_model: "is not in the catalog",
  limited: "is at a usage limit",
  failing: "is failing",
};

/** One passed-over model in words: `openai-codex/gpt-6-luna has no credential here`. */
export const skippedText = (skipped: SkippedModel): string =>
  `${modelText(skipped.model)} ${SKIP_WORDS[skipped.reason]}`;

type UnresolvedReason = Extract<
  RoleCheck["resolution"],
  { readonly _tag: "Unresolved" }
>["reason"];

const UNRESOLVED_WORDS: Readonly<Record<UnresolvedReason, string>> = {
  unbound_role: "Not bound",
  invalid_spec: "Not a role or model",
  no_ready_model: "No ready model",
};

/** What a role resolves to now, in words with a tone. */
export interface RoleStatus {
  readonly word: string;
  readonly detail: Option.Option<string>;
  readonly tone: MeterTone;
}

/** A role's status from its `roles.check` answer. */
export const roleStatusOf = (check: RoleCheck): RoleStatus => {
  const family = check.sameFamilyAsWorker
    ? Option.some("Same model family as @worker.")
    : Option.none<string>();

  return Match.value(check.resolution).pipe(
    Match.tagsExhaustive({
      Resolved: ({ resolved }): RoleStatus => {
        const fallback = resolved.via === "fallback";

        const detail = [
          `Resolves to ${modelText(resolved.model)}${fallback ? ", its fallback" : ""}.`,
          ...resolved.skipped.map(
            (skipped) => `Skipped: ${skippedText(skipped)}.`
          ),
          ...Option.toArray(family),
        ];

        return {
          word: fallback ? "On its fallback" : "Ready",
          detail: Option.some(detail.join(" ")),
          tone: fallback || check.sameFamilyAsWorker ? "waiting" : "done",
        };
      },
      Unresolved: ({ reason, skipped }): RoleStatus => {
        const lines = skipped.map(skippedText);

        return {
          word: UNRESOLVED_WORDS[reason],
          detail:
            lines.length === 0
              ? Option.none()
              : Option.some(
                  `${lines.join("; ")}. Rebind it to a model that is ready.`
                ),
          tone: "failed",
        };
      },
    })
  );
};

/** A model choice in the role editor: its value is `provider/modelId`. */
export interface ModelChoice {
  readonly value: string;
  readonly label: string;
  readonly available: boolean;
}

/**
 * The models a role can be bound to: every listed model, available ones first, and the role's
 * current model even when the catalog does not list it (a Codex binding with no Codex login), so the
 * select shows what the role is bound to rather than another model.
 */
export const modelChoicesOf = (
  catalog: ReadonlyArray<ModelListing>,
  current: ModelRef
): ReadonlyArray<ModelChoice> => {
  const listed = catalog.map((listing): ModelChoice => ({
    value: modelText(listing),
    label: listing.available
      ? `${listing.name} (${modelText(listing)})`
      : `${listing.name} (${modelText(listing)}, not available)`,
    available: listing.available,
  }));

  const currentValue = modelText(current);

  const missing: ReadonlyArray<ModelChoice> = listed.some(
    (choice) => choice.value === currentValue
  )
    ? []
    : [
        {
          value: currentValue,
          label: `${currentValue} (not in the catalog)`,
          available: false,
        },
      ];

  return [
    ...missing,
    ...listed.filter((choice) => choice.available),
    ...listed.filter((choice) => !choice.available),
  ];
};

/** The thinking levels a binding can take on `model`: the catalog's, or every level when unknown. */
export const thinkingChoicesOf = (
  catalog: ReadonlyArray<ModelListing>,
  model: ModelRef,
  every: ReadonlyArray<ThinkingLevel>
): ReadonlyArray<ThinkingLevel> =>
  Option.match(
    Array.findFirst(
      catalog,
      (listing) =>
        listing.provider === model.provider && listing.modelId === model.modelId
    ),
    { onNone: () => every, onSome: (listing) => listing.thinkingLevels }
  );

/**
 * The table with `role` bound to `model`: its thinking level kept while the new model takes it
 * (else the model's default), its fallbacks kept less the new model, its note kept.
 */
export const rebindModel = (
  table: RoleTable,
  role: RoleName,
  model: ModelRef,
  levels: ReadonlyArray<ThinkingLevel>
): Option.Option<RoleTable> =>
  Option.map(Option.fromUndefinedOr(table[role]), (binding): RoleTable => {
    const next: RoleBinding = {
      model,
      thinkingLevel: Option.filter(binding.thinkingLevel, (level) =>
        levels.includes(level)
      ),
      fallbacks: binding.fallbacks.filter(
        (fallback) => modelText(fallback) !== modelText(model)
      ),
      note: binding.note,
    };

    return { ...table, [role]: next };
  });

/** The table with `role`'s thinking level set (none: the model's default). */
export const rebindThinking = (
  table: RoleTable,
  role: RoleName,
  level: Option.Option<ThinkingLevel>
): Option.Option<RoleTable> =>
  Option.map(Option.fromUndefinedOr(table[role]), (binding): RoleTable => ({
    ...table,
    [role]: { ...binding, thinkingLevel: level },
  }));
