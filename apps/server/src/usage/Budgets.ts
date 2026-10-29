// Budgets (ADR 0036, models note section 4): where each scope stands against its budget, the
// admission check a delegating tool runs before it creates work, the text the `beforeTool` gate
// blocks with, and per-role estimates from past children.
//
// - A budget binds what it can see. A dollar limit (`maxListMicros`) counts priced tokens only, at
//   list price; a token limit (`maxTokens`) counts every token. `maxTurns`, `maxMinutes` and
//   `planGuard` are carried by the payload and not enforced here (a workflow's meter, 5B, owns
//   turns and minutes; the bridge's plan windows already shrink its slots).
// - The documents are the authority (`BudgetSources`): a scope's budget is its brief's or a
//   declared one, raised by each accepted `budget_raise` approval. `load` rebuilds the in-memory
//   `BudgetBook` from them at boot; `refresh` re-reads one scope when a raise is answered.
// - `evaluate` reads each covering scope's spend from the ledger (a roll-up over the lineage
//   subtree) and returns the scopes whose state moved; the guard acts on those. Spend lands only
//   when a response completes, so a scope passes its line by at most one response per running
//   conversation before the gate and the guard stop it.
// - An estimate is the median and 90th percentile of completed children's spend per role, and
//   none below five samples: "no estimate yet" is never a made-up figure.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Micros, SpendScope } from "@cairn/protocol/Spend";
import type { Budget, BudgetState, Spend } from "@cairn/protocol/Spend";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { BudgetSources } from "../brain/BudgetSources.ts";
import type { BudgetSourceError } from "../brain/BudgetSources.ts";
import { BudgetBook, DELEGATING_TOOLS, WIND_DOWN_TOOLS } from "./BudgetBook.ts";
import type {
  BudgetLimit,
  BudgetMode,
  Covering,
  ScopeLimit,
  ScopeSpent,
  ScopeStanding,
} from "./BudgetBook.ts";
import { SpendLedger, tokenTotal } from "./SpendLedger.ts";
import type { SpendLedgerError } from "./SpendLedger.ts";

/** Below this many completed children of a role, there is no estimate. */
export const ESTIMATE_MIN_SAMPLES = 5;

/** The scope a delegating tool would add work to is at its line. Nothing was created. */
export class BudgetExhausted extends Schema.TaggedError<BudgetExhausted>()(
  "BudgetExhausted",
  {
    message: Schema.String,
    /** The thread heading the scope that is at its line. */
    scope: Schema.String,
    limit: Schema.Literals(["dollars", "tokens"]),
    spent: Schema.Int,
    max: Schema.Int,
  }
) {}

/** What a ledger roll-up says a scope spent, as a budget reads it. */
export const spentOf = (spend: Spend): ScopeSpent => ({
  listMicros: spend.listMicros,
  tokens: tokenTotal(spend.tokens),
  unpricedTokens: spend.unpricedTokens,
});

/** How far along each enforced limit a scope is, as fractions of the limit. */
const fractionsOf = (budget: Budget, spent: ScopeSpent) => {
  const fractions: Array<readonly [BudgetLimit, number]> = [];

  if (budget.maxListMicros !== null) {
    fractions.push([
      "dollars",
      budget.maxListMicros === 0
        ? Number.POSITIVE_INFINITY
        : spent.listMicros / budget.maxListMicros,
    ]);
  }

  if (budget.maxTokens !== null) {
    fractions.push(["tokens", spent.tokens / budget.maxTokens]);
  }

  return fractions;
};

/**
 * Where a scope stands: `none` with no enforced limit, `exhausted` once any limit is reached,
 * `warned` past the warning line, `within` otherwise.
 */
export const standingOf = (
  budget: Budget,
  spent: ScopeSpent
): ScopeStanding => {
  const fractions = fractionsOf(budget, spent);

  if (fractions.length === 0) {
    return { state: "none", spent, reached: Option.none() };
  }

  const reached = Option.fromUndefinedOr(
    fractions.find(([, fraction]) => fraction >= 1)?.[0]
  );

  const worst = Math.max(...fractions.map(([, fraction]) => fraction));

  if (Option.isSome(reached)) {
    return { state: "exhausted", spent, reached };
  }

  const state: BudgetState = worst >= budget.warnAt ? "warned" : "within";

  return { state, spent, reached };
};

/** A dollar figure from micros, to the cent, or "under $0.01". */
export const dollarsOf = (micros: number): string =>
  micros > 0 && micros < 10_000
    ? "under $0.01"
    : `$${(micros / 1_000_000).toFixed(2)}`;

/** A token count as people read it: 950, 12.3k, 1.2M. */
export const tokensOf = (tokens: number): string => {
  if (tokens < 1000) {
    return String(tokens);
  }

  return tokens < 1_000_000
    ? `${(tokens / 1000).toFixed(1).replace(/\.0$/u, "")}k`
    : `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
};

/** "$0.42 of $0.40 at API list price" or "120k of 100k tokens", for the limit named. */
export const figureOf = (
  budget: Budget,
  spent: ScopeSpent,
  limit: BudgetLimit
): string =>
  limit === "dollars"
    ? `${dollarsOf(spent.listMicros)} of ${dollarsOf(budget.maxListMicros ?? 0)} at API list price`
    : `${tokensOf(spent.tokens)} of ${tokensOf(budget.maxTokens ?? 0)} tokens`;

/** One limit of a budget as words: "$0.80 at API list price" or "200k tokens". */
export const limitText = (budget: Budget, limit: BudgetLimit): string =>
  limit === "dollars"
    ? `${dollarsOf(budget.maxListMicros ?? 0)} at API list price`
    : `${tokensOf(budget.maxTokens ?? 0)} tokens`;

/** The limit to name for a standing: the one reached, else the furthest along. */
const namedLimit = (budget: Budget, standing: ScopeStanding): BudgetLimit =>
  Option.getOrElse(standing.reached, () => {
    const fractions = fractionsOf(budget, standing.spent).toSorted(
      (a, b) => b[1] - a[1]
    );

    return fractions[0]?.[0] ?? "tokens";
  });

/** The notice a scope's thread shows when it reaches its line. */
export const stoppedText = (limit: ScopeLimit, standing: ScopeStanding) => {
  const figure = figureOf(
    limit.budget,
    standing.spent,
    namedLimit(limit.budget, standing)
  );

  return limit.mode === "stop"
    ? `Budget reached: stopped at ${figure}. Running work may pass the line by up to one response per running child. Approve the raise to continue.`
    : `Budget reached at ${figure}: no new subagent work starts here; running subagents finish under their own budgets. Approve the raise to continue.`;
};

/** The notice a scope's thread shows when it passes its warning line. */
export const warningText = (limit: ScopeLimit, standing: ScopeStanding) =>
  `Budget at ${Math.round(limit.budget.warnAt * 100)} percent: ${figureOf(
    limit.budget,
    standing.spent,
    namedLimit(limit.budget, standing)
  )}.`;

/** What a refused tool call or delegation reads, naming the scope and the figure. */
export const refusalText = (covering: Covering, delegating: boolean) => {
  const { limit, standing } = covering;

  const figure = figureOf(
    limit.budget,
    standing.spent,
    namedLimit(limit.budget, standing)
  );

  return delegating || limit.mode === "drain"
    ? `Budget reached for thread ${limit.threadId} (${figure}), so no new subagent work starts. Finish with what you have, or ask the user to approve the raise.`
    : `Budget reached for thread ${limit.threadId} (${figure}), so this work stops here. Reply in plain text with what you have; no more tool calls run.`;
};

/** The budget a raise proposes: every reached limit doubled (all of them when none is), the rest kept. */
export const raisedBudget = (
  budget: Budget,
  reached: Option.Option<BudgetLimit>
): Budget => {
  const raises = (limit: BudgetLimit) =>
    Option.match(reached, {
      onNone: () => true,
      onSome: (which) => which === limit,
    });

  return {
    ...budget,
    maxListMicros:
      budget.maxListMicros === null || !raises("dollars")
        ? budget.maxListMicros
        : Micros.make(Math.max(budget.maxListMicros * 2, 10_000)),
    maxTokens:
      budget.maxTokens === null || !raises("tokens")
        ? budget.maxTokens
        : budget.maxTokens * 2,
  };
};

/** A past child's spend, for estimates. */
export interface EstimateSample {
  readonly listMicros: number;
  readonly tokens: number;
}

/** A role's estimate: its median and 90th percentile, over at least five completed children. */
export interface RoleEstimate {
  readonly samples: number;
  readonly tokensMedian: number;
  readonly tokensHigh: number;
  readonly listMicrosMedian: number;
  readonly listMicrosHigh: number;
}

/** The nearest-rank percentile of sorted values. */
const percentile = (sorted: ReadonlyArray<number>, fraction: number) =>
  sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;

/** The estimate over `samples`; none below `ESTIMATE_MIN_SAMPLES`. */
export const estimateOf = (
  samples: ReadonlyArray<EstimateSample>
): Option.Option<RoleEstimate> => {
  if (samples.length < ESTIMATE_MIN_SAMPLES) {
    return Option.none();
  }

  const tokens = samples
    .map((sample) => sample.tokens)
    .toSorted((a, b) => a - b);

  const micros = samples
    .map((sample) => sample.listMicros)
    .toSorted((a, b) => a - b);

  return Option.some({
    samples: samples.length,
    tokensMedian: percentile(tokens, 0.5),
    tokensHigh: percentile(tokens, 0.9),
    listMicrosMedian: percentile(micros, 0.5),
    listMicrosHigh: percentile(micros, 0.9),
  });
};

/** One scope whose state moved in an evaluation. */
export interface Transition {
  readonly limit: ScopeLimit;
  readonly before: ScopeStanding;
  readonly after: ScopeStanding;
}

/** The covering scopes of `threadId` at their line, own first. */
const exhaustedOf = (coverings: ReadonlyArray<Covering>) =>
  coverings.filter((covering) => covering.standing.state === "exhausted");

/**
 * What the `beforeTool` gate answers for a call of `tool` in a thread covered by `own`, whose
 * delegating call names a subagent covered by `target`: the text to block it with, or none. A scope
 * at its line in `stop` mode blocks every tool but the wind-down ones; in either mode it blocks
 * delegation, its own and to a subagent under it.
 */
export const gateDecision = (
  tool: string,
  own: ReadonlyArray<Covering>,
  target: ReadonlyArray<Covering>
): Option.Option<string> => {
  const delegating = DELEGATING_TOOLS.has(tool);

  for (const covering of exhaustedOf(own)) {
    if (
      delegating ||
      (covering.limit.mode === "stop" && !WIND_DOWN_TOOLS.has(tool))
    ) {
      return Option.some(refusalText(covering, delegating));
    }
  }

  const [first] = delegating ? exhaustedOf(target) : [];

  return first === undefined
    ? Option.none()
    : Option.some(refusalText(first, true));
};

/** Where budgets stand, what may start, and what past children cost. */
export class Budgets extends Context.Service<
  Budgets,
  {
    /**
     * Rebuilds the book from the documents and the lineage, then evaluates every scope: the boot
     * step, run before the Harness resumes. Returns each scope as it now stands.
     */
    readonly load: Effect.Effect<
      ReadonlyArray<Transition>,
      BudgetSourceError | SpendLedgerError
    >;
    /** Re-reads one scope from the documents (a raise answered, a child started) and evaluates it. */
    refresh(
      threadId: ThreadId
    ): Effect.Effect<
      ReadonlyArray<Transition>,
      BudgetSourceError | SpendLedgerError
    >;
    /** Gives `threadId`'s subtree a budget of its own (a goal), kept in the thread's documents. */
    declare(
      threadId: ThreadId,
      budget: Budget,
      mode: BudgetMode
    ): Effect.Effect<
      ReadonlyArray<Transition>,
      BudgetSourceError | SpendLedgerError
    >;
    /** Evaluates every scope covering these threads; returns the ones whose state moved. */
    evaluate(
      threads: ReadonlyArray<ThreadId>
    ): Effect.Effect<ReadonlyArray<Transition>, SpendLedgerError>;
    /**
     * Refuses new work under `threadId` (a spawn from it, a send to it) when a scope covering it is
     * at its line. Creates nothing either way, so a rerun asks again.
     */
    admit(threadId: ThreadId): Effect.Effect<void, BudgetExhausted>;
    /**
     * The text to block a tool call with, or none. `target` is the subagent a delegating call names,
     * whose own scopes refuse new work too.
     */
    gate(
      threadId: ThreadId,
      tool: string,
      target: Option.Option<ThreadId>
    ): Effect.Effect<Option.Option<string>>;
    /** A role's estimate from its completed children; none below five. */
    estimate(
      role: string
    ): Effect.Effect<
      Option.Option<RoleEstimate>,
      BudgetSourceError | SpendLedgerError
    >;
  }
>()("cairn/server/usage/Budgets") {
  /** Needs `BudgetBook`, `BudgetSources` and `SpendLedger`. */
  static readonly layerNoDeps = Layer.effect(
    Budgets,
    Effect.gen(function* () {
      const book = yield* BudgetBook;
      const sources = yield* BudgetSources;
      const ledger = yield* SpendLedger;

      /** What `threadId`'s subtree spent; nothing for a thread the shell no longer has. */
      const spentUnder = (threadId: ThreadId) =>
        ledger.rollup(SpendScope.members[0].make({ threadId })).pipe(
          Effect.map(spentOf),
          Effect.catchTag("SpendScopeNotFound", () =>
            Effect.succeed<ScopeSpent>({
              listMicros: 0,
              tokens: 0,
              unpricedTokens: 0,
            })
          )
        );

      const evaluateScopes = Effect.fnUntraced(function* (
        scopes: ReadonlyArray<ScopeLimit>
      ) {
        const moved: Array<Transition> = [];

        for (const limit of scopes) {
          const after = standingOf(
            limit.budget,
            yield* spentUnder(limit.threadId)
          );

          const before = yield* book.stand(limit.threadId, after);

          if (before.state !== after.state) {
            moved.push({ limit, before, after });
          }
        }

        if (moved.length > 0) {
          yield* ledger.touch(moved.map((each) => each.limit.threadId));
        }

        return moved;
      });

      const evaluate = Effect.fn("Budgets.evaluate")(function* (
        threads: ReadonlyArray<ThreadId>
      ) {
        yield* book.setParents(yield* ledger.parents);

        const scopes = new Map<ThreadId, ScopeLimit>();

        for (const threadId of threads) {
          for (const covering of yield* book.coveringOf(threadId)) {
            scopes.set(covering.limit.threadId, covering.limit);
          }
        }

        return yield* evaluateScopes([...scopes.values()]);
      });

      const load = Effect.gen(function* () {
        const found = yield* sources.scopes;

        for (const limit of yield* book.limits) {
          yield* book.remove(limit.threadId);
        }

        for (const limit of found) {
          yield* book.set(limit);
        }

        yield* book.setParents(yield* ledger.parents);

        const moved = yield* evaluateScopes(found);

        yield* Effect.logInfo(`loaded ${found.length} budget scopes`).pipe(
          Effect.annotateLogs({
            event: "budgets_loaded",
            scopes: found.length,
            exhausted: moved.filter((each) => each.after.state === "exhausted")
              .length,
          })
        );

        return moved;
      }).pipe(Effect.withSpan("Budgets.load"));

      const refresh = Effect.fn("Budgets.refresh")(function* (
        threadId: ThreadId
      ) {
        const found = yield* sources.scopeOf(threadId);

        if (Option.isNone(found)) {
          yield* book.remove(threadId);

          return [];
        }

        yield* book.set(found.value);
        yield* book.setParents(yield* ledger.parents);

        return yield* evaluateScopes([found.value]);
      });

      const declare = Effect.fn("Budgets.declare")(function* (
        threadId: ThreadId,
        budget: Budget,
        mode: BudgetMode
      ) {
        yield* sources.declare(threadId, budget, mode);

        return yield* refresh(threadId);
      });

      const admit = Effect.fn("Budgets.admit")(function* (threadId: ThreadId) {
        const [first] = exhaustedOf(yield* book.coveringOf(threadId));

        if (first === undefined) {
          return yield* Effect.void;
        }

        const limit = Option.getOrElse(
          first.standing.reached,
          () => "tokens" as const
        );

        return yield* new BudgetExhausted({
          message: refusalText(first, true),
          scope: first.limit.threadId,
          limit,
          spent:
            limit === "dollars"
              ? first.standing.spent.listMicros
              : first.standing.spent.tokens,
          max:
            (limit === "dollars"
              ? first.limit.budget.maxListMicros
              : first.limit.budget.maxTokens) ?? 0,
        });
      });

      const gate = Effect.fn("Budgets.gate")(function* (
        threadId: ThreadId,
        tool: string,
        target: Option.Option<ThreadId>
      ) {
        return gateDecision(
          tool,
          yield* book.coveringOf(threadId),
          Option.isSome(target) ? yield* book.coveringOf(target.value) : []
        );
      });

      const estimate = Effect.fn("Budgets.estimate")(function* (role: string) {
        const children = (yield* sources.samples).filter(
          (sample) => sample.role === role
        );

        const samples: Array<{ listMicros: number; tokens: number }> = [];

        for (const child of children) {
          const spent = yield* spentUnder(child.threadId);

          samples.push({ listMicros: spent.listMicros, tokens: spent.tokens });
        }

        return estimateOf(samples);
      });

      return Budgets.of({
        load,
        refresh,
        declare,
        evaluate,
        admit,
        gate,
        estimate,
      });
    })
  );
}
