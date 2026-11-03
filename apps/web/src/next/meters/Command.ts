// The meters' Commands: one question to the brain per section. Each answers with one Message; a
// failure carries the brain's sentence when it sent one.

import { SpendScope } from "@cairn/protocol/Spend";
import { Effect, Schema } from "effect";
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
