// The sidebar's Commands: minting command ids for intents, the clock, navigation, a new draft's id,
// the saved shelves, the platform and the favicon badge. Each answers with one Message.

import { Clock, Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { pushUrl } from "foldkit/navigation";

import { mintCommandId } from "../composer/Ids.ts";
import { applyFaviconBadge } from "../shell/Notifications.ts";
import { Intent, mintDraftId, toShellCommand } from "./Intent.ts";
import { Message } from "./Message.ts";

export type { Services } from "../Command.ts";

/** How long the undo notice stays. */
export const UNDO_NOTICE_MS = 5000;

/** The localStorage keys the open shelves are saved under. */
export const SHELF_STORAGE_KEYS = {
  snoozed: "cairn:sidebar:snoozed-expanded",
  settled: "cairn:sidebar:settled-expanded",
} as const;

/** Mints a command id per intent and returns the shell commands, in order. */
export const IssueCommands = Command.define("IssueCommands", {
  args: { intents: Schema.Array(Intent) },
  messages: [Message.IssuedCommands],
  execute: ({ intents }) =>
    Effect.gen(function* () {
      const commands = [];

      for (const intent of intents) {
        commands.push(toShellCommand(intent, yield* mintCommandId));
      }

      return Message.IssuedCommands({ commands });
    }),
});

/**
 * Reads the clock once at start (T29): the clock subscription drops its first tick, so without
 * this the sidebar reads 0 for up to 15 s, ages say "now" and snooze presets land in 1970.
 */
export const ReadClock = Command.define("ReadClock", {
  messages: [Message.Ticked],
  execute: Effect.map(Clock.currentTimeMillis, (nowMs) =>
    Message.Ticked({ nowMs })
  ),
});

/** Moves to a path inside the app. */
export const NavigateTo = Command.define("NavigateTo", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigate],
  execute: ({ url }) =>
    pushUrl(url).pipe(Effect.as(Message.CompletedNavigate())),
});

/** Mints the id of a new draft. */
export const MintDraftId = Command.define("MintDraftId", {
  messages: [Message.MintedDraftId],
  execute: Effect.map(mintDraftId, (draftId) =>
    Message.MintedDraftId({ draftId })
  ),
});

const decodeSavedBoolean = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Boolean)
);

const readSaved = (key: string) =>
  Effect.gen(function* () {
    const store = yield* KeyValueStore.KeyValueStore;
    const saved = yield* store.get(key);

    return Option.flatMap(Option.fromUndefinedOr(saved), decodeSavedBoolean);
  }).pipe(Effect.orElseSucceed(() => Option.none<boolean>()));

/** Reads which shelves this device left open. */
export const LoadShelves = Command.define("LoadShelves", {
  messages: [Message.LoadedShelves],
  execute: Effect.gen(function* () {
    const snoozedExpanded = yield* readSaved(SHELF_STORAGE_KEYS.snoozed);
    const settledExpanded = yield* readSaved(SHELF_STORAGE_KEYS.settled);

    return Message.LoadedShelves({ snoozedExpanded, settledExpanded });
  }),
});

/** Reads whether this is an Apple platform, where `mod` is Command. */
export const DetectPlatform = Command.define("DetectPlatform", {
  messages: [Message.DetectedPlatform],
  execute: Effect.sync(() =>
    Message.DetectedPlatform({
      isMac: /mac|iphone|ipad|ipod/iu.test(globalThis.navigator.platform),
    })
  ),
});

/** Shows `count` on the favicon. */
export const SetBadge = Command.define("SetBadge", {
  args: { count: Schema.Int },
  messages: [Message.CompletedSetBadge],
  execute: ({ count }) =>
    Effect.sync(() => {
      applyFaviconBadge(count);

      return Message.CompletedSetBadge();
    }),
});
