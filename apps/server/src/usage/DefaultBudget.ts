// The server's default budget (ADR 0047, models note section 4): what a subagent's brief or a
// workflow's launch carries for each limit its model's call does not name. `subagent_spawn` and
// `workflow_plan` read it when they propose, and the proposal freezes the result into its approval
// record, so the card shows what will run and a later change to the default never moves a budget
// already asked. Only dollars at list price and tokens are offered: a call names `max_usd` and
// `max_tokens`, and the default gives the rest, its warning line included.
//
// The tools run outside Effect, so they read the setting through `DefaultBudgetAccess`, which runs
// `SettingsStore.get` with the layer's context (S43).

import type { Budget } from "@cairn/protocol/Spend";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Context } from "effect";
import { Effect, Option, Result } from "effect";

import type { SettingsStore } from "../models/SettingsStore.ts";

/** The limits a model's call names, each none when it names it not. */
export interface AskedBudget {
  readonly maxTokens: Option.Option<number>;
  /** Dollars at list price, as the call gives them. */
  readonly maxUsd: Option.Option<number>;
}

/** Nothing asked: the default's limits throughout. */
export const NOTHING_ASKED: AskedBudget = {
  maxTokens: Option.none(),
  maxUsd: Option.none(),
};

/** Dollars as list-price micros, to the micro. */
export const microsOfUsd = (usd: number): Micros =>
  Micros.make(Math.round(usd * 1_000_000));

/**
 * The budget a proposal carries: each limit `asked` names, and the default's otherwise, with the
 * default's warning line. Only dollars and tokens are offered, so a turn, minute or plan-window
 * limit a default might hold is not carried: no card shows one (ADR 0047).
 */
export const budgetAsked = (fallback: Budget, asked: AskedBudget): Budget => ({
  ...DEFAULT_BUDGET,
  warnAt: fallback.warnAt,
  maxTokens: Option.getOrElse(asked.maxTokens, () => fallback.maxTokens),
  maxListMicros: Option.match(asked.maxUsd, {
    onNone: () => fallback.maxListMicros,
    onSome: microsOfUsd,
  }),
});

/**
 * The server's default budget, for a tool that runs outside Effect: the setting, or the words the
 * model is told when it could not be read.
 */
export interface DefaultBudgetAccess {
  readonly read: () => Promise<Result.Result<Budget, string>>;
}

/** No default set: every limit a call does not name is none. For tests and judges without settings. */
export const NO_DEFAULT_BUDGET: DefaultBudgetAccess = {
  read: async () => await Promise.resolve(Result.succeed(DEFAULT_BUDGET)),
};

/** A fixed default, for tests and judges that plant one. */
export const fixedDefaultBudget = (budget: Budget): DefaultBudgetAccess => ({
  read: async () => await Promise.resolve(Result.succeed(budget)),
});

/** What the model reads when the default budget could not be read. Nothing was proposed. */
export const DEFAULT_UNREAD =
  "The server's default budget could not be read, so nothing was proposed. Try the same call again.";

/** `SettingsStore.get`'s default budget, run with `context` (the layer's, S43). */
export const defaultBudgetAccess = (
  settings: SettingsStore["Service"],
  context: Context.Context<never>
): DefaultBudgetAccess => {
  const run = Effect.runPromiseWith(context);

  return {
    read: async () =>
      await run(
        settings.get.pipe(
          Effect.map((found) => Result.succeed(found.defaultBudget)),
          Effect.catchTag("SettingsStoreError", (error) =>
            Effect.logWarning("default budget not read").pipe(
              Effect.annotateLogs({
                event: "default_budget_unread",
                error: error.message,
              }),
              Effect.as(Result.fail(DEFAULT_UNREAD))
            )
          )
        )
      ),
  };
};
