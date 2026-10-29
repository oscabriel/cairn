// The spend ledger (`usage/SpendLedger.ts`, ADR 0036). `spend_totals` is a derived cache of each
// conversation's `pi.usage` document, one row per model (or tool) key: replaced from the document,
// never added to blindly, and rebuilt at boot, so a `kill -9` cannot double count. `spend_events`
// holds model calls outside any conversation (a thread's title, its branch name), each written once
// under its `(source, key, model_key)`. `list_micros` is null when the model has no list price;
// `unpriced_tokens` counts the tokens no price covers, so unknown is never shown as zero. Money is
// integer millionths of a dollar; times are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `spend_totals` and `spend_events`. */
export const Spend0009 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE spend_totals (
      conversation_id INTEGER NOT NULL,
      model_key TEXT NOT NULL,
      thread_id TEXT,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      reasoning INTEGER,
      list_micros INTEGER,
      basis TEXT NOT NULL,
      unpriced_tokens INTEGER NOT NULL,
      updated_seq INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, model_key)
    )
  `;
  yield* sql`CREATE INDEX spend_totals_thread ON spend_totals (thread_id)`;

  yield* sql`
    CREATE TABLE spend_events (
      source TEXT NOT NULL,
      key TEXT NOT NULL,
      model_key TEXT NOT NULL,
      thread_id TEXT,
      input INTEGER NOT NULL,
      output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      reasoning INTEGER,
      list_micros INTEGER,
      basis TEXT NOT NULL,
      unpriced_tokens INTEGER NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (source, key, model_key)
    )
  `;
  yield* sql`CREATE INDEX spend_events_thread ON spend_events (thread_id)`;
});
