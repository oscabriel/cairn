// Ported from github.com/pingdotgg/t3code, apps/server/src/persistence/OrchestrationEventStore.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: one sequence space for projects and threads, paged
// replay (`READ_PAGE_SIZE = 500`) that skips rows of unknown kinds, the latest sequence, the replay
// payload statistics, and a PubSub of committed events. Changed: one small table of thin events
// (the stream refetches rows rather than replaying payloads), pruning to the newest 5,000 events,
// and no import or prompt-hint machinery.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  PubSub,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import { SqlClient } from "effect/sql";

import {
  DEFAULT_LIVE_STREAM_LIMITS,
  replayAndBufferProjectedLiveEvents,
} from "./LiveStreamBudget.ts";
import type { LiveStreamBufferError } from "./LiveStreamBudget.ts";
import { ShellEventType } from "./ShellCommands.ts";
import type { PlannedShellEvent } from "./ShellCommands.ts";
import { shellStoreFailure } from "./ShellStoreError.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";

/** Rows read per replay page. */
export const READ_PAGE_SIZE = 500;

/** The log keeps this many newest events; a resume from before them gets a snapshot. */
export const SHELL_EVENT_RETENTION = 5000;

/** A committed shell event. Thin: which row changed and how, never the row itself. */
export type StoredShellEvent = PlannedShellEvent & {
  readonly sequence: number;
  readonly occurredAt: DateTime.Utc;
  readonly commandId: string;
};

const StoredRowFields = {
  sequence: Schema.Int,
  event_type: Schema.String,
  occurred_at: Schema.DateTimeUtcFromMillis,
  command_id: Schema.String,
};

// The aggregate id is decoded with the id schema its kind names, so readers get branded ids.
const StoredRow = Schema.Union([
  Schema.Struct({
    ...StoredRowFields,
    aggregate_kind: Schema.Literal("project"),
    aggregate_id: ProjectId,
  }),
  Schema.Struct({
    ...StoredRowFields,
    aggregate_kind: Schema.Literal("thread"),
    aggregate_id: ThreadId,
  }),
]);

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredRow));

const decodeSequences = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ value: Schema.NullOr(Schema.Int) }))
);

const decodeStats = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ events: Schema.Int, bytes: Schema.Int }))
);

const isKnownType = Schema.is(ShellEventType);

/** Turns a stored row into an event, or none for a kind this build does not know. */
const toEvent = (
  row: typeof StoredRow.Type
): Option.Option<StoredShellEvent> => {
  const type = row.event_type;

  if (!isKnownType(type)) {
    return Option.none();
  }

  const common = {
    type,
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    commandId: row.command_id,
  };

  return Option.some(
    row.aggregate_kind === "project"
      ? { ...common, aggregateKind: "project", aggregateId: row.aggregate_id }
      : { ...common, aggregateKind: "thread", aggregateId: row.aggregate_id }
  );
};

/** The size of a replay range, so a resume can choose a snapshot instead. */
export interface ReplayStats {
  readonly events: number;
  readonly payloadBytes: number;
}

/** The shell event log: append inside a command's transaction, publish after it commits. */
export class EventStore extends Context.Service<
  EventStore,
  {
    /** Appends `events` in order for one command. Call only inside the event sink's transaction. */
    append(input: {
      readonly commandId: string;
      readonly occurredAt: DateTime.Utc;
      readonly events: Arr.NonEmptyReadonlyArray<PlannedShellEvent>;
      /** The command, encoded; stored for diagnosis, never replayed. */
      readonly payloadJson: string;
    }): Effect.Effect<
      Arr.NonEmptyReadonlyArray<StoredShellEvent>,
      ShellStoreError
    >;
    /** Deletes all but the newest `SHELL_EVENT_RETENTION` events and the receipts they cover. */
    readonly prune: Effect.Effect<void, ShellStoreError>;
    /** The newest committed sequence; 0 before the first event. Never goes down. */
    readonly latestSequence: Effect.Effect<number, ShellStoreError>;
    /** The oldest sequence still in the log; none when the log is empty. */
    readonly earliestRetainedSequence: Effect.Effect<
      Option.Option<number>,
      ShellStoreError
    >;
    /** The events in `(afterSequence, throughSequence]`, in order, skipping unknown kinds. */
    readRange(input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
    }): Stream.Stream<StoredShellEvent, ShellStoreError>;
    /** How many events and payload bytes `(afterSequence, throughSequence]` holds. */
    replayStats(input: {
      readonly afterSequence: number;
      readonly throughSequence: number;
    }): Effect.Effect<ReplayStats, ShellStoreError>;
    /** Hands committed events to live subscribers. Call after the commit, in commit order. */
    publish(events: ReadonlyArray<StoredShellEvent>): Effect.Effect<void>;
    /** A live subscription to committed events, for as long as the scope lasts. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<StoredShellEvent>,
      never,
      Scope.Scope
    >;
    /**
     * Every committed event after `afterSequence` that passes `filter`: the stored ones first, then
     * live ones, buffered under the live stream budget.
     */
    eventsAfter(
      afterSequence: number,
      filter: (event: StoredShellEvent) => boolean
    ): Stream.Stream<StoredShellEvent, ShellStoreError | LiveStreamBufferError>;
  }
>()("cairn/server/shell/EventStore") {
  /** Reads and writes `shell_events` through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    EventStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const pubsub = yield* PubSub.unbounded<StoredShellEvent>();

      const append = Effect.fn("EventStore.append")(function* (input: {
        readonly commandId: string;
        readonly occurredAt: DateTime.Utc;
        readonly events: Arr.NonEmptyReadonlyArray<PlannedShellEvent>;
        readonly payloadJson: string;
      }) {
        const occurredAt = DateTime.toEpochMillis(input.occurredAt);

        const stored = yield* Effect.forEach(input.events, (event) =>
          sql`
              INSERT INTO shell_events (
                aggregate_kind, aggregate_id, event_type, occurred_at, command_id, payload_json
              )
              VALUES (
                ${event.aggregateKind},
                ${event.aggregateId},
                ${event.type},
                ${occurredAt},
                ${input.commandId},
                ${input.payloadJson}
              )
              RETURNING sequence, aggregate_kind, aggregate_id, event_type, occurred_at, command_id
            `.pipe(
            Effect.flatMap(decodeRows),
            Effect.map((rows) => Arr.getSomes(rows.map(toEvent)))
          )
        );

        const events = stored.flat();

        return Arr.isReadonlyArrayNonEmpty(events)
          ? events
          : yield* Effect.die(
              "EventStore.append wrote events it could not read back"
            );
      }, shellStoreFailure("EventStore.append"));

      const latestSequence = sql`
        SELECT seq AS value FROM sqlite_sequence WHERE name = 'shell_events'
      `.pipe(
        Effect.flatMap(decodeSequences),
        Effect.map((rows) => rows[0]?.value ?? 0),
        shellStoreFailure("EventStore.latestSequence")
      );

      const earliestRetainedSequence = sql`
        SELECT MIN(sequence) AS value FROM shell_events
      `.pipe(
        Effect.flatMap(decodeSequences),
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.value)),
        shellStoreFailure("EventStore.earliestRetainedSequence")
      );

      const prune = Effect.gen(function* () {
        const latest = yield* latestSequence;
        const floor = latest - SHELL_EVENT_RETENTION;

        if (floor <= 0) {
          return;
        }

        yield* sql`DELETE FROM shell_events WHERE sequence <= ${floor}`.pipe(
          shellStoreFailure("EventStore.prune")
        );
        yield* sql`DELETE FROM command_receipts WHERE result_sequence <= ${floor}`.pipe(
          shellStoreFailure("EventStore.prune")
        );
      }).pipe(Effect.withSpan("EventStore.prune"));

      const readPage = (afterSequence: number, throughSequence: number) =>
        sql`
          SELECT sequence, aggregate_kind, aggregate_id, event_type, occurred_at, command_id
          FROM shell_events
          WHERE sequence > ${afterSequence} AND sequence <= ${throughSequence}
          ORDER BY sequence
          LIMIT ${READ_PAGE_SIZE}
        `.pipe(
          Effect.flatMap(decodeRows),
          shellStoreFailure("EventStore.readRange")
        );

      const readRange = (input: {
        readonly afterSequence: number;
        readonly throughSequence: number;
      }) =>
        Stream.paginate(input.afterSequence, (cursor) =>
          readPage(cursor, input.throughSequence).pipe(
            Effect.map(
              (rows) =>
                [
                  Arr.getSomes(rows.map(toEvent)),
                  rows.length < READ_PAGE_SIZE
                    ? Option.none()
                    : Option.map(Arr.last(rows), (row) => row.sequence),
                ] as const
            )
          )
        );

      const replayStats = Effect.fn("EventStore.replayStats")(
        function* (input: {
          readonly afterSequence: number;
          readonly throughSequence: number;
        }) {
          const rows = yield* sql`
            SELECT COUNT(*) AS events, COALESCE(SUM(LENGTH(payload_json)), 0) AS bytes
            FROM shell_events
            WHERE sequence > ${input.afterSequence} AND sequence <= ${input.throughSequence}
          `.pipe(Effect.flatMap(decodeStats));

          const [row] = rows;

          return {
            events: row?.events ?? 0,
            payloadBytes: row?.bytes ?? 0,
          };
        },
        shellStoreFailure("EventStore.replayStats")
      );

      const publish = (events: ReadonlyArray<StoredShellEvent>) =>
        PubSub.publishAll(pubsub, events).pipe(Effect.asVoid);

      const subscribe = PubSub.subscribe(pubsub);

      const eventsAfter = (
        afterSequence: number,
        filter: (event: StoredShellEvent) => boolean
      ) =>
        replayAndBufferProjectedLiveEvents(
          {
            subscribe,
            latestSequence,
            replay: (throughSequence) =>
              readRange({ afterSequence, throughSequence }).pipe(
                Stream.filter(filter)
              ),
            afterSequence,
            filter,
            project: (event: StoredShellEvent) => event,
          },
          DEFAULT_LIVE_STREAM_LIMITS
        );

      return EventStore.of({
        append,
        prune,
        latestSequence,
        earliestRetainedSequence,
        readRange,
        replayStats,
        publish,
        subscribe,
        eventsAfter,
      });
    })
  );
}
