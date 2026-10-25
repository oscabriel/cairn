// The settings page's Commands: this device's settings (read, save, apply), one question to the
// brain per section, `settings.update`, the skills reload and Executor's sign-in. Each answers with
// one Message; a failure carries the brain's sentence when it sent one.
import { ProjectId } from "@cairn/protocol/Ids";
import { SettingsPatch } from "@cairn/protocol/Settings";
import { Effect, Predicate, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { load } from "foldkit/navigation";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import type { CairnConnectionService } from "../connection/Connection.ts";
import {
  applyClientSettings,
  ClientSettings,
  loadClientSettings,
  saveClientSettings,
} from "./ClientSettings.ts";
import { Message } from "./Message.ts";

/** The services the settings page's Commands and Subscriptions read. */
export type Services = CairnConnectionService | KeyValueStore.KeyValueStore;

/** A failed call: one of the protocol's errors or the transport's. */
interface CallFailure {
  readonly _tag: string;
}

/** The brain's sentence for a failure, or `fallback`. */
export const failureText = (failure: CallFailure, fallback: string): string =>
  Predicate.hasProperty(failure, "message") &&
  Predicate.isString(failure.message)
    ? failure.message
    : fallback;

/** Reads this device's settings from storage. */
export const LoadClientSettings = Command.define("LoadClientSettings", {
  messages: [Message.LoadedClientSettings],
  execute: Effect.map(loadClientSettings, (settings) =>
    Message.LoadedClientSettings({ settings })
  ),
});

/** Saves this device's settings. */
export const SaveClientSettings = Command.define("SaveClientSettings", {
  args: { settings: ClientSettings },
  messages: [Message.SavedClientSettings],
  execute: ({ settings }) =>
    Effect.map(saveClientSettings(settings), (saved) =>
      Message.SavedClientSettings({ saved })
    ),
});

/** Writes the theme, font sizes and chat width onto the document. */
export const ApplyClientSettings = Command.define("ApplyClientSettings", {
  args: { settings: ClientSettings },
  messages: [Message.AppliedClientSettings],
  execute: ({ settings }) =>
    Effect.as(applyClientSettings(settings), Message.AppliedClientSettings()),
});

/** Asks for the server settings. */
export const FetchServerSettings = Command.define("FetchServerSettings", {
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
            message: failureText(failure, "The settings could not be read."),
          }),
      })
    ),
});

/** Asks for every model and the defaults. */
export const FetchCatalog = Command.define("FetchCatalog", {
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
            message: failureText(failure, "The models could not be listed."),
          }),
      })
    ),
});

/** Asks which providers have a usable credential. */
export const FetchProviders = Command.define("FetchProviders", {
  args: { epoch: Schema.Int },
  messages: [Message.ReceivedProviders, Message.FailedLoad],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["providers.status"]();
      })
    ).pipe(
      Effect.match({
        onSuccess: (providers) =>
          Message.ReceivedProviders({ epoch, providers }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "providers",
            message: failureText(failure, "The providers could not be read."),
          }),
      })
    ),
});

/** Asks where the link to Executor stands. */
export const FetchExecutorStatus = Command.define("FetchExecutorStatus", {
  args: { epoch: Schema.Int },
  messages: [Message.ReceivedExecutorStatus, Message.FailedLoad],
  execute: ({ epoch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["executor.status"]();
      })
    ).pipe(
      Effect.match({
        onSuccess: (status) =>
          Message.ReceivedExecutorStatus({ epoch, status }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "executor",
            message: failureText(
              failure,
              "Executor's status could not be read."
            ),
          }),
      })
    ),
});

/** Asks for a project's skills; `reload` makes the brain read them from disk again. */
export const FetchSkills = Command.define("FetchSkills", {
  args: { epoch: Schema.Int, projectId: ProjectId, reload: Schema.Boolean },
  messages: [Message.ReceivedSkills, Message.FailedLoad],
  execute: ({ epoch, projectId, reload }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return reload
          ? yield* client["skills.reload"]({ projectId })
          : yield* client["skills.list"]({ projectId });
      })
    ).pipe(
      Effect.match({
        onSuccess: (skills) => Message.ReceivedSkills({ epoch, skills }),
        onFailure: (failure) =>
          Message.FailedLoad({
            epoch,
            section: "skills",
            message: failureText(failure, "The skills could not be read."),
          }),
      })
    ),
});

/** Changes server settings; an absent key is left alone. */
export const UpdateServerSettings = Command.define("UpdateServerSettings", {
  args: { patch: SettingsPatch },
  messages: [Message.SucceededServerUpdate, Message.FailedServerUpdate],
  execute: ({ patch }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["settings.update"](patch);
      })
    ).pipe(
      Effect.match({
        onSuccess: (settings) => Message.SucceededServerUpdate({ settings }),
        onFailure: (failure) =>
          Message.FailedServerUpdate({
            message: failureText(
              failure,
              "The setting was not changed. Try again."
            ),
          }),
      })
    ),
});

/** Asks the brain where to grant Executor access again, and goes there. */
export const SignInExecutor = Command.define("SignInExecutor", {
  messages: [Message.OpenedSignIn, Message.FailedSignIn],
  execute: withBoundary(
    Effect.gen(function* () {
      const client = yield* CairnConnection.get;
      const signIn = yield* client["executor.signIn"]();

      yield* load(signIn.authorizeUrl);
    })
  ).pipe(
    Effect.match({
      onSuccess: () => Message.OpenedSignIn(),
      onFailure: (failure) =>
        Message.FailedSignIn({
          message: failureText(
            failure,
            "Executor's sign-in could not be started. Try again."
          ),
        }),
    })
  ),
});
