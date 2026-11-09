// Ported in idea from cairn-v1, apps/web/src/flags.ts and its outbox handling in update.ts at
// 1a5cd4a. Kept: mutations wait in a FIFO saved to localStorage, so a send survives a reconnect or
// a reload, and the transport never replays anything itself. Changed: items are Cairn's v2 inputs,
// each keyed by the id the client minted (`requestId` or `commandId`), so the brain's receipts make
// a resend after an unknown outcome harmless.
//
// The outbox runs only while the connection is `Live`, one item at a time and in order: the head is
// sent, an acknowledgement drops it and sends the next. A retryable failure leaves it at the head,
// sent again after a backoff or by the next connection; any other failure drops it, because sending
// it again cannot succeed. A shell command older than `SHELL_COMMAND_RESEND_WINDOW` is dropped
// unsent: the brain may have forgotten its receipt, and planning it again would act on a thread
// that has moved on since.
//
// Every tab of the browser shares the saved outbox: a save writes only the items this tab queued or
// dropped, and another tab's write is folded in (`TabChanges.ts`).

import { commandMintedAtMillis } from "@cairn/protocol/Ids";
import { ThreadLaunchInput } from "@cairn/protocol/Launch";
import {
  SHELL_COMMAND_RESEND_WINDOW,
  ShellCommand,
} from "@cairn/protocol/ShellCommands";
import { SendInput } from "@cairn/protocol/Thread";
import { Array, Duration, Effect, Option, Predicate, Schema } from "effect";
import { KeyValueStore } from "effect/persistence";
import { defineTaggedUnion } from "foldkit/schema";

import {
  applyListChanges,
  listChanges,
  mergeList,
  mergeStored,
} from "../storage/TabChanges.ts";

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
  inFlight: Option.Option<string>
): ReadonlyArray<OutboxItem> => {
  const item = OutboxItem.Dispatch({ command });

  return Option.match(visitedThread(item), {
    onNone: () => enqueue(outbox, item),
    onSome: (threadId) =>
      enqueue(
        Array.filter(
          outbox,
          (waiting) =>
            Option.contains(inFlight, outboxKey(waiting)) ||
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

/** Removes the item with `key`: it was acknowledged, or it can never succeed. */
export const remove = (
  outbox: ReadonlyArray<OutboxItem>,
  key: string
): ReadonlyArray<OutboxItem> =>
  Array.filter(outbox, (item) => outboxKey(item) !== key);

/**
 * The item to send now: the head, when the connection is live and nothing is in flight. Items go
 * one at a time so the brain sees them in the order they were made.
 */
export const nextToSend = (
  outbox: ReadonlyArray<OutboxItem>,
  inFlight: Option.Option<string>,
  live: boolean
): Option.Option<OutboxItem> =>
  live && Option.isNone(inFlight) ? Array.head(outbox) : Option.none();

const OutboxJson = Schema.fromJsonString(
  Schema.toCodecJson(Schema.Array(OutboxItem))
);

const decodeOutboxJson = Schema.decodeEffect(OutboxJson);

const encodeOutboxJson = Schema.encodeEffect(OutboxJson);

/**
 * Reads the saved outbox. A missing or unreadable value is an empty outbox: the page must start
 * even when an older build saved something this one cannot read.
 */
export const loadOutbox: Effect.Effect<
  ReadonlyArray<OutboxItem>,
  never,
  KeyValueStore.KeyValueStore
> = Effect.gen(function* () {
  const store = yield* KeyValueStore.KeyValueStore;
  const saved = yield* store.get(OUTBOX_STORAGE_KEY);

  return yield* Option.match(Option.fromUndefinedOr(saved), {
    onNone: () => Effect.succeed([]),
    onSome: decodeOutboxJson,
  });
}).pipe(Effect.orElseSucceed(() => []));

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
    loadOutbox,
    mergeList(outboxKey)(base, outbox),
    (next) =>
      Effect.gen(function* () {
        const store = yield* KeyValueStore.KeyValueStore;

        yield* store.set(OUTBOX_STORAGE_KEY, yield* encodeOutboxJson(next));
      })
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
