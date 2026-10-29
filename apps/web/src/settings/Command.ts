// The settings page's Commands: this device's settings (read with the address's `?ui=` over them,
// save, apply), one question to the brain per section, `settings.update`, the skills reload and
// Executor's sign-in. Each answers with one Message; a failure carries the brain's sentence when it
// sent one.

import { ProjectId } from "@cairn/protocol/Ids";
import { SettingsPatch } from "@cairn/protocol/Settings";
import { Effect, Schema } from "effect";
import type { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { load } from "foldkit/navigation";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import type { CairnConnectionService } from "../connection/Connection.ts";
import { failureMessage } from "../connection/Failure.ts";
import { fetchNextFrame } from "../next/FrameLoad.ts";
import {
  applyClientSettings,
  ClientSettings,
  loadClientSettings,
  saveClientSettings,
  withSearchUi,
} from "./ClientSettings.ts";
import { Message } from "./Message.ts";

/** The services the settings page's Commands and Subscriptions read. */
export type Services = CairnConnectionService | KeyValueStore.KeyValueStore;

/**
 * Reads this device's settings from storage, with the address's `?ui=` choice over them; a choice
 * that changes them is saved, so it holds on the pages the app navigates to afterwards.
 */
export const LoadClientSettings = Command.define("LoadClientSettings", {
  messages: [Message.LoadedClientSettings],
  execute: Effect.gen(function* () {
    const saved = yield* loadClientSettings;
    const search = yield* Effect.sync(() => globalThis.location.search);
    const settings = withSearchUi(saved, search);

    if (settings !== saved) {
      yield* saveClientSettings(settings);
    }

    return Message.LoadedClientSettings({ settings });
  }),
});

/** Fetches the `next` views' chunk (`next/FrameLoad.ts`). */
export const LoadNextFrame = Command.define("LoadNextFrame", {
  messages: [Message.LoadedNextFrame, Message.FailedNextFrame],
  execute: fetchNextFrame.pipe(
    Effect.match({
      onSuccess: () => Message.LoadedNextFrame(),
      onFailure: () => Message.FailedNextFrame(),
    })
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
            message: failureMessage(failure, "The settings could not be read."),
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
            message: failureMessage(failure, "The models could not be listed."),
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
            message: failureMessage(
              failure,
              "The providers could not be read."
            ),
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
            message: failureMessage(
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
            message: failureMessage(failure, "The skills could not be read."),
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
            message: failureMessage(
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
          message: failureMessage(
            failure,
            "Executor's sign-in could not be started. Try again."
          ),
        }),
    })
  ),
});
