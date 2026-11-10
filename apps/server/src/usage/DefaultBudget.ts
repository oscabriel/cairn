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

/** The largest dollar budget a call may name: a million dollars at list price. */
export const MAX_USD = 1_000_000;

/** The largest token budget a call may name: a trillion tokens. */
export const MAX_TOKENS = 1_000_000_000_000;

/** What the model reads when its `max_usd` is no budget Cairn can keep. Nothing was proposed. */
export const usdOutOfRange = (usd: number) =>
  `max_usd ${String(usd)} is not a budget Cairn can keep: name between 0.000001 and ${String(MAX_USD)} dollars at list price, or leave it out for the user's default. Nothing was proposed.`;

/** What the model reads when its `max_tokens` is no budget Cairn can keep. Nothing was proposed. */
export const tokensOutOfRange = (tokens: number) =>
  `max_tokens ${String(tokens)} is not a budget Cairn can keep: name a whole number from 1 to ${String(MAX_TOKENS)}, or leave it out for the user's default. Nothing was proposed.`;

/** Dollars as list-price micros, to the micro; none when that is not a micro count above zero. */
export const microsOfUsd = (usd: number): Option.Option<Micros> => {
  const micros = Math.round(usd * 1_000_000);

  return usd <= MAX_USD && micros > 0 && Number.isSafeInteger(micros)
    ? Option.some(Micros.make(micros))
    : Option.none();
};

/**
 * The budget a proposal carries: each limit `asked` names, and the default's otherwise, with the
 * default's warning line; or the words the model reads when a limit it names is out of range (the
 * tools' schemas bound them too, but a schema is advice to a model, not a guard). Only dollars and
 * tokens are offered, so a turn, minute or plan-window limit a default might hold is not carried:
 * no card shows one (ADR 0047).
 */
export const budgetAsked = (
  fallback: Budget,
  asked: AskedBudget
): Result.Result<Budget, string> => {
  const tokens = Option.getOrNull(asked.maxTokens);

  if (
    tokens !== null &&
    !(Number.isSafeInteger(tokens) && tokens >= 1 && tokens <= MAX_TOKENS)
  ) {
    return Result.fail(tokensOutOfRange(tokens));
  }

  const usd = Option.getOrNull(asked.maxUsd);
  const micros = usd === null ? Option.none() : microsOfUsd(usd);

  if (usd !== null && Option.isNone(micros)) {
    return Result.fail(usdOutOfRange(usd));
  }

  return Result.succeed({
    ...DEFAULT_BUDGET,
    warnAt: fallback.warnAt,
    maxTokens: tokens ?? fallback.maxTokens,
    maxListMicros: Option.getOrElse(micros, () => fallback.maxListMicros),
  });
};

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
