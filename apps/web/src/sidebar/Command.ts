// The sidebar's Commands: minting command ids for intents, navigation, timers for the undo notice and
// pending changes, the saved shelves, the clipboard, the favicon badge, the folder browser and task
// retry. Each answers with one Message.

import { ThreadId, TaskId } from "@cairn/protocol/Ids";
import { Clock, Effect, Option, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { Command } from "foldkit";
import { focus } from "foldkit/dom";
import { pushUrl } from "foldkit/navigation";

import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import { failureMessage } from "../connection/Failure.ts";
import { applyFaviconBadge } from "../shell/Notifications.ts";
import {
  Intent,
  mintCommandId,
  mintDraftId,
  toShellCommand,
} from "./Intent.ts";
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

/** Saves which shelves are open on this device. */
export const SaveShelves = Command.define("SaveShelves", {
  args: { snoozedExpanded: Schema.Boolean, settledExpanded: Schema.Boolean },
  messages: [Message.CompletedSaveShelves],
  execute: ({ settledExpanded, snoozedExpanded }) =>
    Effect.gen(function* () {
      const store = yield* KeyValueStore.KeyValueStore;

      yield* store.set(
        SHELF_STORAGE_KEYS.snoozed,
        JSON.stringify(snoozedExpanded)
      );
      yield* store.set(
        SHELF_STORAGE_KEYS.settled,
        JSON.stringify(settledExpanded)
      );

      return Message.CompletedSaveShelves();
    }).pipe(Effect.orElseSucceed(() => Message.CompletedSaveShelves())),
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

/** The browser refused to write to the clipboard (no permission, or the page lost focus). */
export class ClipboardRefused extends Schema.TaggedError<ClipboardRefused>()(
  "ClipboardRefused",
  { cause: Schema.Defect() }
) {}

/** Copies `text` to the clipboard. */
export const CopyText = Command.define("CopyText", {
  args: { text: Schema.String },
  messages: [Message.CompletedCopy],
  execute: ({ text }) =>
    Effect.tryPromise({
      try: async () => {
        await globalThis.navigator.clipboard.writeText(text);
      },
      catch: (cause) => new ClipboardRefused({ cause }),
    }).pipe(
      Effect.match({
        onSuccess: () => Message.CompletedCopy({ succeeded: true }),
        onFailure: () => Message.CompletedCopy({ succeeded: false }),
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

/** Focuses the element `selector` names, when it exists. */
export const FocusElement = Command.define("FocusElement", {
  args: { selector: Schema.String },
  messages: [Message.CompletedFocus],
  execute: ({ selector }) =>
    focus(selector).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
});

/** Lists the folders in `path` (the home folder when none) for the add-project dialog. */
export const BrowseFolder = Command.define("BrowseFolder", {
  args: { request: Schema.Int, path: Schema.Option(Schema.String) },
  messages: [Message.ReceivedListing, Message.FailedListing],
  execute: ({ path, request }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        return yield* client["projects.browse"]({ path });
      })
    ).pipe(
      Effect.match({
        onSuccess: (result) => Message.ReceivedListing({ request, result }),
        onFailure: (failure) =>
          Message.FailedListing({
            request,
            message: failureMessage(
              failure,
              "The folder could not be listed. Try again."
            ),
          }),
      })
    ),
});

/** Asks the brain to retry a parked task. */
export const RetryTask = Command.define("RetryTask", {
  args: { threadId: ThreadId, taskId: TaskId },
  messages: [Message.SucceededRetry, Message.FailedRetry],
  execute: ({ taskId, threadId }) =>
    withBoundary(
      Effect.gen(function* () {
        const client = yield* CairnConnection.get;

        yield* client["thread.retryTask"]({ threadId, taskId });
      })
    ).pipe(
      Effect.match({
        onSuccess: () => Message.SucceededRetry(),
        onFailure: (failure) =>
          Message.FailedRetry({
            message: failureMessage(
              failure,
              "The task could not be retried. Try again."
            ),
          }),
      })
    ),
});
