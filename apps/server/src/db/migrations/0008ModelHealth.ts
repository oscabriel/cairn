// Provider health (`models/ModelHealth.ts`): one row per provider with its last success, last
// failure, last auth failure, newest transient failures and the usage limit it is under, so a
// restart does not forget a revoked login or a spent plan. `error` holds only words from a fixed
// vocabulary, never a provider's text. Times are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `model_health`. */
export const ModelHealth0008 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE model_health (
      provider_id TEXT PRIMARY KEY,
      last_ok INTEGER,
      last_fail INTEGER,
      last_auth INTEGER,
      transient_json TEXT NOT NULL,
      limited_at INTEGER,
      limited_until INTEGER,
      error TEXT,
      updated_at INTEGER NOT NULL
    )
  `;
});
