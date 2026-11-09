// A login's floor on provider health (`models/ModelHealth.ts`): `reset_at` is when a login or logout
// last reset the provider, so an outcome of a request made before it never counts against the new
// credential, even when it arrives after the reset or after a restart. Epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Adds `model_health.reset_at`. */
export const ModelHealthReset0013 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE model_health ADD COLUMN reset_at INTEGER`;
});
