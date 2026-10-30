// The meters' Commands: one question to the brain per section, and `settings.update` with a new role
// table. Each answers with one Message; a failure carries the brain's sentence when it sent one.

import { RoleTable } from "@cairn/protocol/Roles";
import { SpendScope } from "@cairn/protocol/Spend";
import { Effect, Option, Record, Schema } from "effect";
import { Command } from "foldkit";

import { CairnConnection, withBoundary } from "../../connection/Connection.ts";
import type { CairnConnectionService } from "../../connection/Connection.ts";
import { failureMessage } from "../../connection/Failure.ts";
import { Message } from "./Message.ts";

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

/** Asks for the server settings: the role table and the default budget. */
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

/** Asks for every model a role can be bound to. */
export const FetchMetersCatalog = Command.define("FetchMetersCatalog", {
  args: { epoch: Schema.Int },
  messages: [Message.ReceivedCatalog, Message.FailedLoad],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["models.list"]();
      })
    ).pipe(
      Effect.match({
        onSuccess: (catalog) => Message.ReceivedCatalog({ epoch, catalog }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "catalog",
            message: failureMessage(failure, "The models could not be listed."),
          }),
      })
    ),
});

/** Asks what every role of `table` resolves to now. */
export const CheckRoles = Command.define("CheckRoles", {
  args: { epoch: Schema.Int, table: RoleTable },
  messages: [Message.ReceivedRoleChecks, Message.FailedLoad],
  execute: ({ epoch, table }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["roles.check"]({ specs: Record.keys(table) });
      })
    ).pipe(
      Effect.match({
        onSuccess: (checks) => Message.ReceivedRoleChecks({ epoch, checks }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "checks",
            message: failureMessage(
              failure,
              "What each role resolves to could not be checked."
            ),
          }),
      })
    ),
});

/** Saves the whole role table; the brain answers with the settings as they now are. */
export const SaveRoleTable = Command.define("SaveRoleTable", {
  args: { table: RoleTable },
  messages: [Message.SavedRoleTable, Message.FailedRoleSave],
  execute: ({ table }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["settings.update"]({
          autoSettleDays: Option.none(),
          titleModel: Option.none(),
          bridgeEnabled: Option.none(),
          bridgeGenerationCap: Option.none(),
          roleBindings: Option.some(table),
          defaultBudget: Option.none(),
        });
      })
    ).pipe(
      Effect.match({
        onSuccess: (settings) => Message.SavedRoleTable({ settings }),
        onFailure: (failure) =>
          Message.FailedRoleSave({
            message: failureMessage(
              failure,
              "The role was not rebound. Try again."
            ),
          }),
      })
    ),
});
