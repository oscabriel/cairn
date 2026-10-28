// Ported in intent from github.com/HazAT/ultimate, server/events.ts at 8b263386. The log as one
// ownerless conversation, `emit` inside the caller's transaction, and a reactor cursor that moves in
// the transaction of its handler are kept; the code is rewritten for Cairn (ADR 0033): handlers may
// only write through `tx` and create pi-durable tasks, the log rotates monthly, and the cursor names
// its log.
//
// MIT License. Copyright (c) 2026 Daniel Griesser.
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright notice and this
// permission notice shall be included in all copies or substantial portions of the Software. THE
// SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// Durable events (ADR 0033). A fact with several consumers is an entry `event.<name>` appended to
// the event conversation (one ownerless conversation that never runs; the glossary's "Event
// conversation", not the brain's "Events log" of JSON lines) inside the commit of the change it
// describes: the event exists exactly when the change does, and the entry id is the global order.
// Its data is the protocol's `EventEnvelope`. The session document `cairn.events` names the current
// event conversation and holds one cursor per reactor. Below, "log" is short for the event
// conversation of one month.
//
// A reactor handles each event of its kinds once, oldest first: one commit reads its cursor, finds
// the next matching entry, runs the handler with that commit's `tx` and moves the cursor. A throw
// rolls the handler's writes and the cursor back together, so database effects happen exactly once
// per (event, reactor). A handler never awaits anything outside `tx` (spec 12, "Long transactions"):
// outside work is a pi-durable task it creates through `tx.createTask`, with idempotent request ids.
//
// Rotation: the first event of a later UTC month opens a new log and appends a `cairn.events-rotated`
// marker naming it to the old one, in the same commit. A cursor that reaches the marker follows it,
// so no event is skipped, and old logs are never scanned again once every cursor has left them.
// About 70 MB a year without it (the workflows note, "Operations").

import { ConversationId, EntryId } from "@cairn/protocol/Ids";
import {
  EventEnvelope,
  EventName,
  EVENTS_DOCUMENT,
} from "@cairn/protocol/Workflows";
import type { JsonValue } from "@earendil-works/chord";
import type {
  Cursor,
  EntryRecord,
  ConversationId as PiConversationId,
  Tx,
} from "@earendil-works/pi-durable";
import { defineDoc, defineEntry } from "@earendil-works/pi-durable";
import { DateTime, Option, Predicate, Schema } from "effect";

import { piConversationId, piEntryId } from "./PiIds.ts";

/** Where one reactor has read to: its log and the last entry it passed there (null: none yet). */
export interface EventCursorState {
  [key: string]: JsonValue;
  logConversationId: number;
  entryId: number | null;
}

/** `cairn.events` state; the plain JSON form of the protocol's `EventsDocument`. */
export interface EventsState {
  [key: string]: JsonValue;
  /** The current log; null until the first event. */
  logConversationId: number | null;
  /** The UTC month the current log covers, `YYYY-MM`. */
  logMonth: string | null;
  cursors: { [reactor: string]: EventCursorState };
}

/** `cairn.events`: the current log and each reactor's cursor (session scope). */
export const EventsDoc = defineDoc<EventsState>({
  kind: EVENTS_DOCUMENT,
  version: 1,
  scope: "session",
  initial: () => ({ logConversationId: null, logMonth: null, cursors: {} }),
  // Every handled event moves a cursor; a base every 50 deltas bounds replay.
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** Data of the marker that closes a log: the log that follows it. */
export type RotatedData = Readonly<{ next: number; month: string }>;

/** The last entry of a rotated log, naming the next one. Not an event: no reactor handles it. */
export const RotatedEntry = defineEntry<RotatedData>("cairn.events-rotated");

/** The entry kind prefix of every event. */
export const EVENT_KIND_PREFIX = "event.";

/** The entry kind of event `name`. */
export const eventKind = (name: EventName) => `${EVENT_KIND_PREFIX}${name}`;

/**
 * The version each event's `data` is written at. Bump it with a shape change, as a document's
 * version; renaming an event is a migration, because kinds are protocol.
 */
export const EVENT_VERSIONS: Readonly<Record<EventName, number>> = {
  "approval.answered": 1,
  "brief.approved": 1,
  "workflow.proposed": 1,
  "workflow.started": 1,
  "workflow.finished": 1,
  "workflow.node.settled": 1,
  "workflow.node.refused": 1,
  "workflow.node.stopped": 1,
  "workflow.budget.soft": 1,
  "workflow.budget.spent": 1,
  "subagent.result": 1,
};

/** One event as a reactor sees it. */
export interface EventRecord {
  /** The log entry's id: the event's place in the global order. */
  readonly id: EntryId;
  readonly name: EventName;
  /** The version `data` was written at (`EVENT_VERSIONS`). */
  readonly v: number;
  /** Epoch milliseconds on the emitter's Harness clock. */
  readonly at: number;
  readonly data: JsonValue;
  /** What the emitter adds about where the event came from (a run, a thread), if anything. */
  readonly context: Option.Option<JsonValue>;
}

/** What an emitter states; the log, the entry id and the version are the log's. */
export interface EventDraft {
  readonly name: EventName;
  readonly data: JsonValue;
  /** Epoch milliseconds on the Harness clock (`runtime.now()` in a task). Picks the log's month. */
  readonly at: number;
  /** Written as `null` when none (S23: the envelope is plain JSON). */
  readonly context: Option.Option<JsonValue>;
}

/**
 * Where a reactor without a cursor starts, when it is first registered (or first steps):
 *
 * - `now`: at the tail of the current log. It handles only events emitted after it was added. Use
 *   it for any reactor whose tasks reach outside (pushes, child starts), so a deploy that adds it
 *   does not replay old facts.
 * - `start`: at the start of the current log, so it also handles the events already emitted this
 *   UTC month. How far back that reaches depends on the day of the deploy, and older months' logs
 *   are never replayed. Only for reactors whose effects are safe to repeat over old facts.
 */
export type ReactorStart = "now" | "start";

/**
 * A reactor: a name, the events it handles and the handler. `handle` runs inside the commit that
 * moves the reactor's cursor. It may read tables (only before its first table write), write
 * documents and entries through `tx`, emit events and create pi-durable tasks; it must not await
 * anything outside `tx`. A throw rolls back its writes and leaves the event pending.
 */
export interface Reactor {
  /**
   * Stable: the cursor is stored under it. Renaming a reactor registers it anew, starting where
   * `from` says.
   */
  readonly name: string;
  readonly events: ReadonlyArray<EventName>;
  /** Where its cursor starts when it has none. */
  readonly from: ReactorStart;
  handle(tx: Tx, event: EventRecord): Promise<void>;
}

/**
 * Builds a reactor. `ReactorFootguns.test.ts` checks its handler: no Session read, and no await of
 * anything but `tx` (or a helper given `tx`).
 */
export const reactor = (
  name: string,
  options: {
    readonly events: ReadonlyArray<EventName>;
    readonly from: ReactorStart;
  },
  handle: (tx: Tx, event: EventRecord) => Promise<void>
): Reactor => ({ name, events: options.events, from: options.from, handle });

/** Plain JSON check for handlers that read `data`: an object, not an array. */
export const isEventObject = (
  value: JsonValue | undefined
): value is { readonly [key: string]: JsonValue } =>
  Predicate.isObject(value) && !Array.isArray(value);

const decodeEventName = Schema.decodeUnknownOption(EventName);

/** The protocol's envelope; `data` and `context` are then read as plain JSON from the entry. */
const decodeEnvelope = Schema.decodeUnknownOption(EventEnvelope);

const decodeRotated = Schema.decodeUnknownOption(
  Schema.Struct({ next: Schema.Int, month: Schema.String })
);

/**
 * The log a rotation marker names. Throws (failing the step, which the reactor status shows) on a
 * malformed marker: passing over it would leave every cursor in a dead log with no lag to report.
 */
const nextLogOf = (entry: EntryRecord): number =>
  Option.getOrThrowWith(
    Option.map(decodeRotated(entry.data), (data) => data.next),
    () =>
      new Error(
        `Rotation marker ${entry.id} names no next log. Every reactor stops here; repair the entry.`
      )
  );

/** The UTC month of epoch milliseconds `at`, `YYYY-MM`. */
export const monthOf = (at: number): string => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(at));

  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}`;
};

const logId = (id: number): PiConversationId =>
  piConversationId(ConversationId.make(id));

/**
 * The event an entry of the log holds, or none for an entry that is not a well-formed event. A
 * malformed event is never skipped silently: the reactor host fails on it (`readEvent`).
 */
const eventOf = (entry: EntryRecord): Option.Option<EventRecord> => {
  if (!entry.kind.startsWith(EVENT_KIND_PREFIX)) {
    return Option.none();
  }

  const { data } = entry;
  const name = decodeEventName(entry.kind.slice(EVENT_KIND_PREFIX.length));
  const envelope = decodeEnvelope(data);

  if (
    Option.isNone(name) ||
    Option.isNone(envelope) ||
    !isEventObject(data) ||
    data.data === undefined ||
    data.context === undefined
  ) {
    return Option.none();
  }

  return Option.some({
    id: EntryId.make(entry.id),
    name: name.value,
    v: envelope.value.v,
    at: envelope.value.at,
    data: data.data,
    context: Option.fromNullOr(data.context),
  });
};

/** The event in a log entry the scan matched; throws (failing the reactor's step) when malformed. */
const readEvent = (entry: EntryRecord): EventRecord =>
  Option.getOrThrowWith(
    eventOf(entry),
    () =>
      new Error(
        `Event entry ${entry.id} (${entry.kind}) is not a well-formed event. It stays pending; repair the entry or the reactor.`
      )
  );

/** The current log, opening a new one first when `at` falls in a later month than it covers. */
const logFor = async (tx: Tx, at: number): Promise<PiConversationId> => {
  const state = await tx.doc(EventsDoc);
  const month = monthOf(at);

  if (state.logConversationId !== null && state.logMonth === null) {
    state.logMonth = month;
  }

  if (
    state.logConversationId !== null &&
    state.logMonth !== null &&
    month <= state.logMonth
  ) {
    return logId(state.logConversationId);
  }

  const created = await tx.createConversation({
    ownership: { kind: "ownerless" },
  });

  if (state.logConversationId !== null) {
    await tx.appendEntry(RotatedEntry, logId(state.logConversationId), {
      data: { next: created.id, month },
    });
  }

  state.logConversationId = created.id;
  state.logMonth = month;

  return created.id;
};

/** The last entry of log `log`, or null for an empty log. Reads tables only. */
const tailOf = async (tx: Tx, log: number): Promise<number | null> => {
  const read = await tx.scanEntries(
    { conversationId: logId(log), order: "descending" },
    1
  );

  return read.items[0]?.id ?? null;
};

/** A new cursor for `target` in the current log `log`, where its `from` says. Reads tables only. */
const newCursor = async (
  tx: Tx,
  target: Pick<Reactor, "from">,
  log: number
): Promise<EventCursorState> => ({
  logConversationId: log,
  entryId: target.from === "now" ? await tailOf(tx, log) : null,
});

/**
 * Gives every reactor in `targets` that has no cursor one in the current log (its tail or its
 * start, as its `from` says), opening the first log if there is none (its month from `at`). The
 * host commits this at start, so a reactor misses no event emitted from then on, even across a
 * rotation before its first step. A `start` reactor first registered after a rotation starts at the
 * current log, not at older ones.
 */
export const registerCursors = async (
  tx: Tx,
  targets: ReadonlyArray<Pick<Reactor, "name" | "from">>,
  at: number
): Promise<void> => {
  // No reactors: the first event opens the log.
  if (targets.length === 0) {
    return;
  }

  const state = await tx.doc(EventsDoc);

  const unregistered = targets.filter(
    (target) => state.cursors[target.name] === undefined
  );

  if (unregistered.length === 0) {
    return;
  }

  // Table reads first (the tail), then the writes.
  const tail =
    state.logConversationId === null
      ? null
      : await tailOf(tx, state.logConversationId);

  if (state.logConversationId === null) {
    const created = await tx.createConversation({
      ownership: { kind: "ownerless" },
    });

    state.logConversationId = created.id;
    state.logMonth = monthOf(at);
  }

  for (const target of unregistered) {
    state.cursors[target.name] = {
      logConversationId: state.logConversationId,
      entryId: target.from === "now" ? tail : null,
    };
  }
};

/**
 * Appends one event to the log inside `tx`, so it commits or rolls back with the caller's writes.
 * Call it in the commit of the change the event describes, after that commit's table reads.
 */
export const emit = async (tx: Tx, draft: EventDraft): Promise<EventRecord> => {
  const log = await logFor(tx, draft.at);
  const v = EVENT_VERSIONS[draft.name];

  const envelope = {
    v,
    at: draft.at,
    data: draft.data,
    context: Option.getOrNull(draft.context),
  } satisfies typeof EventEnvelope.Encoded;

  const entry = await tx.appendEntry(log, {
    kind: eventKind(draft.name),
    data: envelope,
  });

  return {
    id: EntryId.make(entry.id),
    name: draft.name,
    v,
    at: draft.at,
    data: draft.data,
    context: draft.context,
  };
};

/** Entries one scan page reads. */
const PAGE = 256;

/** Where a scan of the log ended: the cursor after it and the matching entry it stopped at. */
interface ScanResult {
  readonly cursor: EventCursorState;
  readonly found: Option.Option<EntryRecord>;
  /** Matching entries counted, when counting. */
  readonly count: number;
}

/**
 * Walks the log from `from`, following rotation markers into later logs. Stops at the first entry
 * of `kinds` unless `count` is set, in which case it counts them (up to `limit`) and reads on.
 */
const walk = async (
  tx: Tx,
  from: EventCursorState,
  kinds: ReadonlySet<string>,
  options: { readonly count: boolean; readonly limit: number }
): Promise<ScanResult> => {
  let log = from.logConversationId;
  let after = from.entryId ?? 0;
  let count = 0;

  for (;;) {
    let next: Option.Option<number> = Option.none();
    let page: Cursor | undefined;

    do {
      // oxlint-disable-next-line no-await-in-loop -- pages are read in order on the commit's line
      const read = await tx.scanEntries(
        {
          conversationId: logId(log),
          minEntryId: piEntryId(EntryId.make(after + 1)),
          order: "ascending",
        },
        PAGE,
        page
      );

      for (const entry of read.items) {
        after = entry.id;

        if (entry.kind === RotatedEntry.kind) {
          next = Option.some(nextLogOf(entry));
          break;
        }

        if (kinds.has(entry.kind)) {
          if (!options.count) {
            return {
              cursor: { logConversationId: log, entryId: entry.id },
              found: Option.some(entry),
              count,
            };
          }

          count += 1;

          if (count >= options.limit) {
            return {
              cursor: { logConversationId: log, entryId: entry.id },
              found: Option.none(),
              count,
            };
          }
        }
      }

      page = Option.isSome(next) ? undefined : read.next;
    } while (page !== undefined);

    if (Option.isNone(next)) {
      return {
        cursor: { logConversationId: log, entryId: after === 0 ? null : after },
        found: Option.none(),
        count,
      };
    }

    log = next.value;
    after = 0;
  }
};

/** The stored cursor of `name`, copied out of the draft. */
const storedCursor = (
  state: EventsState,
  name: string
): Option.Option<EventCursorState> =>
  Option.map(Option.fromUndefinedOr(state.cursors[name]), (stored) => ({
    logConversationId: stored.logConversationId,
    entryId: stored.entryId,
  }));

const sameCursor = (a: EventCursorState, b: EventCursorState) =>
  a.logConversationId === b.logConversationId && a.entryId === b.entryId;

/** The kinds a reactor handles, as entry kinds. */
export const reactorKinds = (target: Reactor): ReadonlySet<string> =>
  new Set(target.events.map(eventKind));

/**
 * Where a reactor stands: the next pending event after `from`, if any, and the cursor that passes
 * it. Reads tables only. The judge's broken control keeps `from` in memory instead of the document.
 */
export const nextPending = async (
  tx: Tx,
  from: EventCursorState,
  kinds: ReadonlySet<string>
): Promise<{
  readonly event: Option.Option<EventRecord>;
  readonly cursor: EventCursorState;
}> => {
  const result = await walk(tx, from, kinds, { count: false, limit: 0 });

  return {
    event: Option.map(result.found, readEvent),
    cursor: result.cursor,
  };
};

/**
 * One reactor step inside one commit: find the reactor's next pending event, run its handler with
 * this `tx`, and move its cursor past the event (and past the entries of other kinds before it).
 * Returns the event handled, or none when nothing was pending. `attempt` learns the event before
 * the handler runs, so a failure can name it after the rollback.
 */
export const reactOnce = async (
  tx: Tx,
  target: Reactor,
  kinds: ReadonlySet<string>,
  attempt: (event: EventRecord) => void
): Promise<Option.Option<EventRecord>> => {
  const state = await tx.doc(EventsDoc);
  const from = storedCursor(state, target.name);

  // Registered late (start could not commit): this step only registers it, where `from` says.
  if (Option.isNone(from)) {
    if (state.logConversationId !== null) {
      state.cursors[target.name] = await newCursor(
        tx,
        target,
        state.logConversationId
      );
    }

    return Option.none();
  }

  const pending = await nextPending(tx, from.value, kinds);

  if (Option.isSome(pending.event)) {
    attempt(pending.event.value);
    await target.handle(tx, pending.event.value);
  }

  if (!sameCursor(from.value, pending.cursor)) {
    state.cursors[target.name] = { ...pending.cursor };
  }

  return pending.event;
};

/**
 * Matching events after a reactor's cursor, counted up to `limit`. Reads only. A reactor with no
 * cursor yet counts from where it would start.
 */
export const lagOf = async (
  tx: Tx,
  target: Reactor,
  kinds: ReadonlySet<string>,
  limit: number
): Promise<number> => {
  const state = await tx.doc(EventsDoc);
  const stored = storedCursor(state, target.name);

  let from: EventCursorState;

  if (Option.isSome(stored)) {
    from = stored.value;
  } else if (state.logConversationId === null) {
    return 0;
  } else {
    from = await newCursor(tx, target, state.logConversationId);
  }

  const result = await walk(tx, from, kinds, { count: true, limit });

  return result.count;
};

/** True for a log entry a reactor of `kinds` must wake for: one of its events, or a rotation. */
export const wakesFor = (kind: string, kinds: ReadonlySet<string>) =>
  kinds.has(kind) || kind === RotatedEntry.kind;

/** True when `kind` is an event or a rotation marker: an entry worth waking any reactor for. */
export const isLogEntryKind = (kind: string) =>
  kind.startsWith(EVENT_KIND_PREFIX) || kind === RotatedEntry.kind;
