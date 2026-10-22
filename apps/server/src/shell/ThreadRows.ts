// One row per thread in `cairn.sqlite`: its sidebar row (inbox state plus the cached pi-durable
// activity) stored whole as the wire `ThreadShell`, beside the columns queries filter on, a
// tombstone, and the last time a snooze woke (auto-settle counts from it). Only the shell store's
// event sink writes rows, inside its command transaction.
import type { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ThreadShell } from "@cairn/protocol/Shell";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { shellStoreFailure } from "./ShellStoreError.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";

/** A thread as stored. */
export interface ThreadRow {
  readonly shell: ThreadShell;
  /** Set when the thread was deleted from the shell; its transcript stays in the brain. */
  readonly deletedAt: Option.Option<DateTime.Utc>;
  /** When a snooze last ended, by hand or by its timer. */
  readonly lastSnoozeWakeAt: Option.Option<DateTime.Utc>;
}

const OptionalMillis = Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis);

const StoredThread = Schema.Struct({
  deleted_at: OptionalMillis,
  last_snooze_wake_at: OptionalMillis,
  shell_json: Schema.fromJsonString(Schema.toCodecJson(ThreadShell)),
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredThread));

const encodeShell = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ThreadShell))
);

const toRow = (stored: typeof StoredThread.Type): ThreadRow => ({
  shell: stored.shell_json,
  deletedAt: stored.deleted_at,
  lastSnoozeWakeAt: stored.last_snooze_wake_at,
});

const millisOrNull = (value: Option.Option<DateTime.Utc>) =>
  Option.match(value, { onNone: () => null, onSome: DateTime.toEpochMillis });

/** Whether a thread is in the shell: neither archived nor deleted. */
export const isLiveThread = (row: ThreadRow) =>
  Option.isNone(row.deletedAt) && Option.isNone(row.shell.archivedAt);

/** The thread rows of `cairn.sqlite`. */
export class ThreadRows extends Context.Service<
  ThreadRows,
  {
    /** The row for `threadId`, in any state. */
    get(
      threadId: ThreadId
    ): Effect.Effect<Option.Option<ThreadRow>, ShellStoreError>;
    /** Every thread in the shell (neither archived nor deleted), oldest first. */
    readonly listLive: Effect.Effect<ReadonlyArray<ThreadRow>, ShellStoreError>;
    /** The project's threads that are not deleted, archived ones included. */
    listByProject(
      projectId: ProjectId
    ): Effect.Effect<ReadonlyArray<ThreadRow>, ShellStoreError>;
    /** The earliest snooze end among threads in the shell. */
    readonly nextSnoozeEnd: Effect.Effect<
      Option.Option<DateTime.Utc>,
      ShellStoreError
    >;
    /** Threads in the shell whose snooze ended at or before `now`. */
    snoozesEndedBy(
      now: DateTime.Utc
    ): Effect.Effect<ReadonlyArray<ThreadRow>, ShellStoreError>;
    /** Inserts or replaces a row. Call only inside the event sink's transaction. */
    write(row: ThreadRow): Effect.Effect<void, ShellStoreError>;
  }
>()("cairn/server/shell/ThreadRows") {
  /** Reads and writes through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    ThreadRows,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const get = Effect.fn("ThreadRows.get")(function* (threadId: ThreadId) {
        const rows = yield* sql`
            SELECT deleted_at, last_snooze_wake_at, shell_json FROM threads WHERE id = ${threadId}
          `.pipe(Effect.flatMap(decodeRows));

        return Option.map(Option.fromNullishOr(rows[0]), toRow);
      }, shellStoreFailure("ThreadRows.get"));

      const listLive = sql`
        SELECT deleted_at, last_snooze_wake_at, shell_json FROM threads
        WHERE archived_at IS NULL AND deleted_at IS NULL
        ORDER BY created_at, id
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows.map(toRow)),
        shellStoreFailure("ThreadRows.listLive"),
        Effect.withSpan("ThreadRows.listLive")
      );

      const listByProject = Effect.fn("ThreadRows.listByProject")(function* (
        projectId: ProjectId
      ) {
        const rows = yield* sql`
            SELECT deleted_at, last_snooze_wake_at, shell_json FROM threads
            WHERE project_id = ${projectId} AND deleted_at IS NULL
            ORDER BY created_at, id
          `.pipe(Effect.flatMap(decodeRows));

        return rows.map(toRow);
      }, shellStoreFailure("ThreadRows.listByProject"));

      const NextSnoozeEnd = Schema.Array(
        Schema.Struct({
          next: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
        })
      );

      const decodeNextSnoozeEnd = Schema.decodeUnknownEffect(NextSnoozeEnd);

      const nextSnoozeEnd = sql`
        SELECT MIN(snoozed_until) AS next FROM threads
        WHERE snoozed_until IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL
      `.pipe(
        Effect.flatMap(decodeNextSnoozeEnd),
        Effect.map((rows) =>
          Option.flatMap(Option.fromNullishOr(rows[0]), (row) => row.next)
        ),
        shellStoreFailure("ThreadRows.nextSnoozeEnd"),
        Effect.withSpan("ThreadRows.nextSnoozeEnd")
      );

      const snoozesEndedBy = Effect.fn("ThreadRows.snoozesEndedBy")(function* (
        now: DateTime.Utc
      ) {
        const rows = yield* sql`
            SELECT deleted_at, last_snooze_wake_at, shell_json FROM threads
            WHERE snoozed_until IS NOT NULL AND snoozed_until <= ${DateTime.toEpochMillis(now)}
              AND archived_at IS NULL AND deleted_at IS NULL
            ORDER BY snoozed_until, id
          `.pipe(Effect.flatMap(decodeRows));

        return rows.map(toRow);
      }, shellStoreFailure("ThreadRows.snoozesEndedBy"));

      const write = Effect.fn("ThreadRows.write")(function* (row: ThreadRow) {
        const { shell } = row;
        const shellJson = yield* encodeShell(shell);

        yield* sql`
            INSERT INTO threads (
              id, project_id, created_at, updated_at, archived_at, deleted_at, snoozed_until,
              last_snooze_wake_at, shell_json
            )
            VALUES (
              ${shell.id},
              ${shell.projectId},
              ${DateTime.toEpochMillis(shell.createdAt)},
              ${DateTime.toEpochMillis(shell.updatedAt)},
              ${millisOrNull(shell.archivedAt)},
              ${millisOrNull(row.deletedAt)},
              ${millisOrNull(shell.snoozedUntil)},
              ${millisOrNull(row.lastSnoozeWakeAt)},
              ${shellJson}
            )
            ON CONFLICT (id) DO UPDATE SET
              project_id = excluded.project_id,
              updated_at = excluded.updated_at,
              archived_at = excluded.archived_at,
              deleted_at = excluded.deleted_at,
              snoozed_until = excluded.snoozed_until,
              last_snooze_wake_at = excluded.last_snooze_wake_at,
              shell_json = excluded.shell_json
          `;
      }, shellStoreFailure("ThreadRows.write"));

      return ThreadRows.of({
        get,
        listLive,
        listByProject,
        nextSnoozeEnd,
        snoozesEndedBy,
        write,
      });
    })
  );
}
