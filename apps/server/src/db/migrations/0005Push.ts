// Web Push's tables: one row per browser push subscription (keyed by its endpoint), the shell event
// log position the notifier has handled, and one row per run or alert a push was decided for, so a
// restart or a replayed event never pushes the same thing twice. Times are epoch milliseconds.
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `push_subscriptions`, `push_cursor` and `notified_runs`. */
export const Push0005 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      login TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_ok_at INTEGER
    )
  `;

  yield* sql`
    CREATE TABLE push_cursor (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      sequence INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE notified_runs (
      key TEXT PRIMARY KEY,
      thread_id TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('sent', 'suppressed')),
      created_at INTEGER NOT NULL
    )
  `;
  yield* sql`CREATE INDEX notified_runs_created ON notified_runs (created_at)`;
});
