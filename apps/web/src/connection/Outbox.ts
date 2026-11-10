// Ported in idea from cairn-v1, apps/web/src/flags.ts and its outbox handling in update.ts at
// 1a5cd4a. Kept: mutations wait in a FIFO saved to localStorage, so a send survives a reconnect or
// a reload, and the transport never replays anything itself. Changed: items are Cairn's v2 inputs,
// each keyed by the id the client minted (`requestId` or `commandId`), so the brain's receipts make
// a resend after an unknown outcome harmless.
//
// The outbox runs only while the connection is `Live`, in lanes: each thread's sends and launch wait
// in that thread's lane, and shell commands in the shell's (a command naming a thread whose launch
// is still waiting joins that thread's lane, so it never reaches the brain before the thread). Each
// lane sends one item at a time and in order: its head is sent, an acknowledgement drops it and
// sends the next, so a launch the brain holds for minutes holds only its own thread. A retryable
// failure leaves an item at its lane's head, sent again after a backoff or by the next connection;
// any other failure drops it, because sending it again cannot succeed. A shell command older than
// `SHELL_COMMAND_RESEND_WINDOW` is dropped unsent: the brain may have forgotten its receipt, and
// planning it again would act on a thread that has moved on since.
//
// Every tab of the browser shares the saved outbox: a save writes only the items this tab queued or
// dropped, and another tab's write is folded in (`TabChanges.ts`). Items are read one by one: an
// item this build cannot decode is kept as stored and sent by a build that can, and the page says
// it holds sends it cannot show.

import { commandMintedAtMillis } from "@cairn/protocol/Ids";
import { ThreadLaunchInput } from "@cairn/protocol/Launch";
import {
  SHELL_COMMAND_RESEND_WINDOW,
  ShellCommand,
} from "@cairn/protocol/ShellCommands";
import { SendInput } from "@cairn/protocol/Thread";
import { Array, Duration, Match, Option, Predicate, Schema } from "effect";
import type { Effect } from "effect";
import type { KeyValueStore } from "effect/persistence";
import { defineTaggedUnion } from "foldkit/schema";

import {
  applyListChanges,
  listChanges,
  persistedList,
  mergeList,
  mergeStored,
  readShared,
} from "../storage/TabChanges.ts";
import type { Loaded } from "../storage/TabChanges.ts";

// The saved outbox is this union as it stands, with the protocol's inputs as they are, so a change to
// `SendInput`, `ShellCommand` or `ThreadLaunchInput` is a change to it. Add a field as optional, or a
// literal, and an older build keeps the items it cannot decode as stored (`TabChanges.ts`); change
// what a stored field means, or the list's outer shape, and bump `OUTBOX_STORAGE_KEY`'s version.
/** One mutation waiting for the brain's acknowledgement. */
export const OutboxItem = defineTaggedUnion({
  /** `thread.send`, idempotent by its input's `requestId`. */
  Send: { input: SendInput },
  /** `shell.dispatch`, idempotent by the command's `commandId`. */
  Dispatch: { command: ShellCommand },
  /** `thread.launch`, idempotent by its `commandId`. */
  Launch: { input: ThreadLaunchInput },
});

export type OutboxItem = typeof OutboxItem.Type;

/** The localStorage key the outbox is saved under. */
export const OUTBOX_STORAGE_KEY = "cairn:outbox:v1";

/** The id an item is acknowledged and deduplicated by. */
export const outboxKey = (item: OutboxItem): string =>
  OutboxItem.match(item, {
    Send: ({ input }) => input.input.requestId,
    Dispatch: ({ command }) => command.commandId,
    Launch: ({ input }) => input.commandId,
  });

/** Adds an item at the end, unless an item with its key is already waiting. */
export const enqueue = (
  outbox: ReadonlyArray<OutboxItem>,
  item: OutboxItem
): ReadonlyArray<OutboxItem> =>
  Array.some(outbox, (waiting) => outboxKey(waiting) === outboxKey(item))
    ? outbox
    : [...outbox, item];

/** The thread a queued `thread.visit` marks, when `item` is one. */
const visitedThread = (item: OutboxItem): Option.Option<string> =>
  Predicate.isTagged(item, "Dispatch") &&
  Predicate.isTagged(item.command, "ThreadVisit")
    ? Option.some(item.command.threadId)
    : Option.none();

/**
 * Adds a shell command at the end. A visit replaces the visits to the same thread still waiting
 * behind it: only the latest one matters, and an offline page must not pile them up. The item in
 * flight stays, because the brain may already be applying it.
 */
export const enqueueDispatch = (
  outbox: ReadonlyArray<OutboxItem>,
  command: ShellCommand,
  inFlight: ReadonlyArray<string>
): ReadonlyArray<OutboxItem> => {
  const item = OutboxItem.Dispatch({ command });

  return Option.match(visitedThread(item), {
    onNone: () => enqueue(outbox, item),
    onSome: (threadId) =>
      enqueue(
        Array.filter(
          outbox,
          (waiting) =>
            inFlight.includes(outboxKey(waiting)) ||
            !Option.contains(visitedThread(waiting), threadId)
        ),
        item
      ),
  });
};

/**
 * Whether `item` is a shell command minted more than `SHELL_COMMAND_RESEND_WINDOW` before
 * `nowMillis`, and so must not be sent again.
 */
export const outlivedResendWindow = (
  item: OutboxItem,
  nowMillis: number
): boolean =>
  Predicate.isTagged(item, "Dispatch") &&
  nowMillis - commandMintedAtMillis(item.command.commandId) >
    Duration.toMillis(SHELL_COMMAND_RESEND_WINDOW);

/** The shell commands' lane. */
const SHELL_LANE = "shell";

/** A thread's lane. */
const threadLane = (threadId: string): string => `thread:${threadId}`;

/** The thread a shell command names, when it names one. */
const commandThread = (command: ShellCommand): Option.Option<string> =>
  Predicate.hasProperty(command, "threadId") &&
  Predicate.isString(command.threadId)
    ? Option.some(command.threadId)
    : Option.none();

/**
 * The lane `item` waits in within `outbox`: its thread's for a send or a launch, the shell's for a
 * shell command, unless the command names a thread whose launch `outbox` still holds.
 */
export const outboxLane = (
  item: OutboxItem,
  outbox: ReadonlyArray<OutboxItem>
): string =>
  OutboxItem.match(item, {
    Send: ({ input }) => threadLane(input.threadId),
    Launch: ({ input }) => threadLane(input.threadId),
    Dispatch: ({ command }) =>
      Option.match(
        Option.filter(commandThread(command), (threadId) =>
          Array.some(
            outbox,
            (waiting) =>
              Predicate.isTagged(waiting, "Launch") &&
              waiting.input.threadId === threadId
          )
        ),
        { onNone: () => SHELL_LANE, onSome: threadLane }
      ),
  });

/** Removes the item with `key`: it was acknowledged, or it can never succeed. */
export const remove = (
  outbox: ReadonlyArray<OutboxItem>,
  key: string
): ReadonlyArray<OutboxItem> =>
  Array.filter(outbox, (item) => outboxKey(item) !== key);

/**
 * The items to send now, while the connection is live: each lane's head, unless an item of that
 * lane is in flight (`inFlight`) or waiting out its resend backoff (`waiting`). A lane sends one
 * item at a time, so the brain sees a thread's sends in the order they were made.
 */
export const readyToSend = (
  outbox: ReadonlyArray<OutboxItem>,
  inFlight: ReadonlyArray<string>,
  waiting: ReadonlyArray<string>,
  live: boolean
): ReadonlyArray<OutboxItem> => {
  if (!live) {
    return [];
  }

  const busy = new Set(
    Array.filter(outbox, (item) => {
      const key = outboxKey(item);

      return inFlight.includes(key) || waiting.includes(key);
    }).map((item) => outboxLane(item, outbox))
  );

  const heads = new Map<string, OutboxItem>();

  for (const item of outbox) {
    const lane = outboxLane(item, outbox);

    if (!heads.has(lane)) {
      heads.set(lane, item);
    }
  }

  return [...heads].flatMap(([lane, item]) => (busy.has(lane) ? [] : [item]));
};

/** The key an item has wherever it sits in the stored JSON, read even from an item that does not decode. */
const OutboxItemKey = Schema.Union([
  Schema.TaggedStruct("Send", {
    input: Schema.Struct({
      input: Schema.Struct({ requestId: Schema.String }),
    }),
  }),
  Schema.TaggedStruct("Dispatch", {
    command: Schema.Struct({ commandId: Schema.String }),
  }),
  Schema.TaggedStruct("Launch", {
    input: Schema.Struct({ commandId: Schema.String }),
  }),
]);

const decodeOutboxItemKey = Schema.decodeUnknownOption(OutboxItemKey);

const unreadOutboxKey = (json: Schema.Json): Option.Option<string> =>
  Option.map(decodeOutboxItemKey(json), (item) =>
    Match.valueTags(item, {
      Send: ({ input }) => input.input.requestId,
      Dispatch: ({ command }) => command.commandId,
      Launch: ({ input }) => input.commandId,
    })
  );

const persistedOutbox = persistedList(
  Schema.toCodecJson(OutboxItem),
  outboxKey,
  unreadOutboxKey
);

/**
 * Reads the saved outbox, and whether to tell the user storage holds items this build cannot decode
 * (once for each, `readShared`). Missing storage is an empty outbox; an item this build cannot
 * decode, or a value it cannot read at all, is left as stored, so the page starts with every item it
 * can read and never writes over the rest.
 */
export const readOutbox: Effect.Effect<
  Loaded<ReadonlyArray<OutboxItem>>,
  never,
  KeyValueStore.KeyValueStore
> = readShared(OUTBOX_STORAGE_KEY, persistedOutbox);

const outboxChanges = listChanges(outboxKey);

const applyOutboxChanges = applyListChanges(outboxKey);

/**
 * Saves the items this tab queued or dropped since `base` (the outbox as it last read or wrote it)
 * into what storage holds now, so another tab's waiting items are kept, and writes back an item of
 * this tab's that another tab's write dropped without removing it. Answers what storage holds
 * afterwards, or none when storage was full or refused.
 */
export const saveOutbox = (
  base: ReadonlyArray<OutboxItem>,
  outbox: ReadonlyArray<OutboxItem>
): Effect.Effect<
  Option.Option<ReadonlyArray<OutboxItem>>,
  never,
  KeyValueStore.KeyValueStore
> =>
  mergeStored(
    OUTBOX_STORAGE_KEY,
    persistedOutbox,
    mergeList(outboxKey)(base, outbox)
  );

/**
 * This tab's outbox once storage holds `stored`: what it queued or dropped since `written` (what it
 * last wrote or read) stays, and every other item is as stored, so another tab's waiting items are
 * sent from here too (the brain admits each once) and items it settled leave.
 */
export const rebaseOutbox = (
  written: ReadonlyArray<OutboxItem>,
  mine: ReadonlyArray<OutboxItem>,
  stored: ReadonlyArray<OutboxItem>
): ReadonlyArray<OutboxItem> =>
  applyOutboxChanges(stored, outboxChanges(written, mine));
