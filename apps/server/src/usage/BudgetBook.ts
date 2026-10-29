// Where every budget stands, in memory (ADR 0036, models note section 4). The documents are the
// authority: a scope's budget is its brief's (or one declared on its thread), raised by each
// accepted `budget_raise` approval, and `Budgets` rebuilds this book from them at boot and as they
// change. The book only answers fast: the `beforeTool` gate asks it on every tool call, the spend
// ledger asks it for each row's `budget` word, and `Budgets.admit` asks it before a delegating tool
// creates work.
//
// A scope is a thread with a budget and its lineage subtree. A thread is covered by its own scope
// and every ancestor's. At a scope's line its mode decides what stops:
// - `stop`: every conversation of the subtree stops taking work: the gate blocks the next tool call,
//   the guard stops the runs, and delegating tools are refused. A subagent's brief budget is one, so
//   it may pass its line by at most one response per running conversation.
// - `drain`: no new subagent work starts in the subtree (spawns and sends are refused), and running
//   children finish under their own budgets. A goal's budget over its subagents is one.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { Budget, BudgetState } from "@cairn/protocol/Spend";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";

/** What a scope stops at its line (module header). */
export const BudgetMode = Schema.Literals(["stop", "drain"]);

export type BudgetMode = typeof BudgetMode.Type;

/** The limit a budget reached first. */
export const BudgetLimit = Schema.Literals(["dollars", "tokens"]);

export type BudgetLimit = typeof BudgetLimit.Type;

/** A scope: the thread whose subtree a budget covers, the budget as raised, and its mode. */
export interface ScopeLimit {
  readonly threadId: ThreadId;
  readonly budget: Budget;
  readonly mode: BudgetMode;
  /** How many raises were accepted: notices and raise requests are keyed by it, so each lands once. */
  readonly epoch: number;
}

/** What a scope spent, as a budget reads it: a dollar budget binds priced tokens only. */
export interface ScopeSpent {
  readonly listMicros: number;
  readonly tokens: number;
  /** Tokens no price covers, which a dollar limit cannot see. */
  readonly unpricedTokens: number;
}

/** Where one scope stands after its last evaluation. */
export interface ScopeStanding {
  readonly state: BudgetState;
  readonly spent: ScopeSpent;
  /** The limit at or past its line, first dollars then tokens; none below every line. */
  readonly reached: Option.Option<BudgetLimit>;
}

/** One scope covering a thread, with where it stands. */
export interface Covering {
  readonly limit: ScopeLimit;
  readonly standing: ScopeStanding;
}

/** A standing for a scope not evaluated yet: nothing spent. */
export const UNSPENT: ScopeStanding = {
  state: "within",
  spent: { listMicros: 0, tokens: 0, unpricedTokens: 0 },
  reached: Option.none(),
};

/** Whether a budget sets a limit the book enforces: list-price dollars or tokens. */
export const hasLimits = (budget: Budget): boolean =>
  budget.maxListMicros !== null || budget.maxTokens !== null;

/** The tools that delegate work to a subagent: a scope at its line refuses them in either mode. */
export const DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "subagent_spawn",
  "subagent_send",
]);

/**
 * The tools a stopped conversation may still call: handing in what it has is not new work, and a
 * typed child that cannot submit its result would only be nudged again.
 */
export const WIND_DOWN_TOOLS: ReadonlySet<string> = new Set(["submit_result"]);

/** Every thread's parent, from the thread rows' lineage; a thread the map lacks has none. */
export type Parents = ReadonlyMap<ThreadId, ThreadId>;

/** `threadId` and its ancestors, nearest first; a cycle is cut where it closes. */
export const lineOf = (
  threadId: ThreadId,
  parents: Parents
): ReadonlyArray<ThreadId> => {
  const line = [threadId];
  const seen = new Set<ThreadId>(line);
  let current = parents.get(threadId);

  while (current !== undefined && !seen.has(current)) {
    line.push(current);
    seen.add(current);
    current = parents.get(current);
  }

  return line;
};

interface BookState {
  readonly limits: ReadonlyMap<ThreadId, ScopeLimit>;
  readonly standings: ReadonlyMap<ThreadId, ScopeStanding>;
  readonly parents: Parents;
}

const EMPTY: BookState = {
  limits: new Map(),
  standings: new Map(),
  parents: new Map(),
};

/** The scopes, their standings and the lineage they are read over, in memory. */
export class BudgetBook extends Context.Service<
  BudgetBook,
  {
    /** Sets (or raises) a scope; its standing is kept until the next evaluation. */
    set(limit: ScopeLimit): Effect.Effect<void>;
    /** Forgets a scope. */
    remove(threadId: ThreadId): Effect.Effect<void>;
    /** Every scope. */
    readonly limits: Effect.Effect<ReadonlyArray<ScopeLimit>>;
    /** The scope `threadId` heads, if any. */
    limitOf(threadId: ThreadId): Effect.Effect<Option.Option<ScopeLimit>>;
    /** Records a scope's new standing and returns the one it replaces. */
    stand(
      threadId: ThreadId,
      standing: ScopeStanding
    ): Effect.Effect<ScopeStanding>;
    /** Replaces the lineage the book reads coverings over. */
    setParents(parents: Parents): Effect.Effect<void>;
    readonly parents: Effect.Effect<Parents>;
    /** Every scope covering `threadId`, its own first, then its ancestors' nearest first. */
    coveringOf(threadId: ThreadId): Effect.Effect<ReadonlyArray<Covering>>;
    /**
     * The word a thread row shows: its own scope's state, `none` when it heads no scope. A child of
     * a stopped scope keeps its own word; the parent's row says where the scope stands.
     */
    rowState(threadId: ThreadId): Effect.Effect<BudgetState>;
  }
>()("cairn/server/usage/BudgetBook") {
  /** An empty book; `Budgets` fills it from the documents at boot. */
  static readonly layer = Layer.effect(
    BudgetBook,
    Effect.gen(function* () {
      const state = yield* Ref.make<BookState>(EMPTY);

      const set = Effect.fn("BudgetBook.set")(function* (limit: ScopeLimit) {
        yield* Ref.update(state, (current) => ({
          ...current,
          limits: new Map(current.limits).set(limit.threadId, limit),
        }));
      });

      const remove = Effect.fn("BudgetBook.remove")(function* (
        threadId: ThreadId
      ) {
        yield* Ref.update(state, (current) => {
          const limits = new Map(current.limits);
          const standings = new Map(current.standings);

          limits.delete(threadId);
          standings.delete(threadId);

          return { ...current, limits, standings };
        });
      });

      const stand = Effect.fn("BudgetBook.stand")(function* (
        threadId: ThreadId,
        standing: ScopeStanding
      ) {
        return yield* Ref.modify(state, (current) => [
          current.standings.get(threadId) ?? UNSPENT,
          {
            ...current,
            standings: new Map(current.standings).set(threadId, standing),
          },
        ]);
      });

      const coveringIn = (current: BookState, threadId: ThreadId) =>
        lineOf(threadId, current.parents).flatMap((member) => {
          const limit = current.limits.get(member);

          return limit === undefined
            ? []
            : [
                {
                  limit,
                  standing: current.standings.get(member) ?? UNSPENT,
                },
              ];
        });

      return BudgetBook.of({
        set,
        remove,
        limits: Effect.map(Ref.get(state), (current) => [
          ...current.limits.values(),
        ]),
        limitOf: (threadId) =>
          Effect.map(Ref.get(state), (current) =>
            Option.fromUndefinedOr(current.limits.get(threadId))
          ),
        stand,
        setParents: (parents) =>
          Ref.update(state, (current) => ({ ...current, parents })),
        parents: Effect.map(Ref.get(state), (current) => current.parents),
        coveringOf: (threadId) =>
          Effect.map(Ref.get(state), (current) =>
            coveringIn(current, threadId)
          ),
        rowState: (threadId) =>
          Effect.map(Ref.get(state), (current) =>
            current.limits.has(threadId)
              ? (current.standings.get(threadId) ?? UNSPENT).state
              : "none"
          ),
      });
    })
  );
}
