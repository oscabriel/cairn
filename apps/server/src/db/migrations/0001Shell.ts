// The shell store's tables in `cairn.sqlite`: projects, one row per thread, the shell event log the
// shell stream resumes from, command receipts that make `shell.dispatch` idempotent, and the
// server-owned settings. Times are epoch milliseconds. A project's and a thread's sidebar state is
// stored whole as its encoded wire row (`shell_json`); only the fields queries filter or order on
// are columns beside it.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates the shell store's tables. */
export const Shell0001 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      deleted_at INTEGER,
      shell_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX projects_active_workspace_root
      ON projects (workspace_root) WHERE deleted_at IS NULL
  `;

  yield* sql`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects (id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      deleted_at INTEGER,
      snoozed_until INTEGER,
      last_snooze_wake_at INTEGER,
      shell_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX threads_project ON threads (project_id)`;
  yield* sql`
    CREATE INDEX threads_snoozed_until
      ON threads (snoozed_until) WHERE snoozed_until IS NOT NULL AND deleted_at IS NULL
  `;

  yield* sql`
    CREATE TABLE shell_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('project', 'thread')),
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      command_id TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX shell_events_command ON shell_events (command_id)`;

  yield* sql`
    CREATE TABLE command_receipts (
      command_id TEXT PRIMARY KEY,
      command_type TEXT NOT NULL,
      aggregate_kind TEXT NOT NULL CHECK (aggregate_kind IN ('project', 'thread')),
      aggregate_id TEXT NOT NULL,
      accepted_at INTEGER NOT NULL,
      result_sequence INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
      error_json TEXT
    )
  `;
  yield* sql`CREATE INDEX command_receipts_sequence ON command_receipts (result_sequence)`;

  yield* sql`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
