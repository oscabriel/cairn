// The meters' Commands: one question to the brain per section, the read of the line a thread's
// budget form starts from, and the save of a budget form. Each answers with one Message; a failure
// carries the brain's sentence when it sent one.

import { ThreadId } from "@cairn/protocol/Ids";
import { Budget, SpendScope } from "@cairn/protocol/Spend";
import { Effect, Option, Predicate, Schema } from "effect";
import { Command } from "foldkit";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import type { CairnConnectionService } from "../connection/Connection.ts";
import { failureMessage } from "../connection/Failure.ts";
import { Message } from "./Message.ts";
import { BudgetTarget } from "./Model.ts";

/** The services the meters' Commands read. */
export type Services = CairnConnectionService;

/** Everything the brain recorded, calls outside conversations included. */
const ALL = SpendScope.members[3].make({});

/** Asks for the whole spend roll-up. */
export const FetchSpend = Command.define("FetchSpend", {
  args: { epoch: Schema.Int },
  messages: [Message.ReceivedSpend, Message.FailedLoad],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["spend.get"]({ scope: ALL });
      })
    ).pipe(
      Effect.match({
        onSuccess: (spend) => Message.ReceivedSpend({ epoch, spend }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "spend",
            message: failureMessage(failure, "The spend could not be read."),
          }),
      })
    ),
});

/** Reads the line `threadId`'s own scope stands at (`budget.get`), for its budget form. */
export const FetchThreadBudget = Command.define("FetchThreadBudget", {
  args: { threadId: ThreadId },
  messages: [Message.ReceivedThreadBudget, Message.FailedThreadBudget],
  execute: ({ threadId }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["budget.get"]({ threadId });
      })
    ).pipe(
      Effect.match({
        onSuccess: ({ budget }) =>
          Message.ReceivedThreadBudget({ threadId, budget }),
        onFailure: (failure) =>
          Message.FailedThreadBudget({
            threadId,
            message: failureMessage(
              failure,
              "This thread's budget could not be read."
            ),
          }),
      })
    ),
});

/**
 * Saves a budget form's budget (ADR 0047): the server's default through `settings.update`, every
 * other setting left as it is, or a thread's own through `budget.declare`.
 */
export const SaveBudget = Command.define("SaveBudget", {
  args: { target: BudgetTarget, budget: Budget },
  messages: [Message.SavedBudget, Message.FailedSaveBudget],
  execute: ({ target, budget }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        if (Predicate.isTagged(target, "Thread")) {
          yield* client["budget.declare"]({
            threadId: target.threadId,
            budget,
          });

          return Option.none();
        }

        return Option.some(
          yield* client["settings.update"]({
            autoSettleDays: Option.none(),
            titleModel: Option.none(),
            bridgeEnabled: Option.none(),
            bridgeGenerationCap: Option.none(),
            defaultBudget: Option.some(budget),
          })
        );
      })
    ).pipe(
      Effect.match({
        onSuccess: (settings) =>
          Message.SavedBudget({ target, budget, settings }),
        onFailure: (failure) =>
          Message.FailedSaveBudget({
            target,
            message: failureMessage(failure, "The budget was not saved."),
          }),
      })
    ),
});

/** Asks for the server settings, for the default budget. */
export const FetchMetersSettings = Command.define("FetchMetersSettings", {
  args: { epoch: Schema.Int },
  messages: [Message.ReceivedServerSettings, Message.FailedLoad],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["settings.get"]();
      })
    ).pipe(
      Effect.match({
        onSuccess: (settings) =>
          Message.ReceivedServerSettings({ epoch, settings }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "server",
            message: failureMessage(failure, "The settings could not be read."),
          }),
      })
    ),
});
