// Drops `executor_sign_in_needed` (migration 0004). The needs-sign-in signal reaches the user
// through the link's status stream instead: `push/ExecutorSignInPush.ts` pushes it once per lapse
// and `executor.status` answers the client, so nothing read the table and it only grew.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Drops `executor_sign_in_needed`. */
export const ExecutorSignal0006 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS executor_sign_in_needed`;
});
