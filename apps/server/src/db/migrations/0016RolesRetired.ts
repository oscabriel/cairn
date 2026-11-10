// ADR 0052 retires the roles ADR 0043 removed. `cairn.sqlite` keeps one row of them: the role table
// in `settings` under `roleBindings`, which no setting reads since ADR 0043. It is deleted. The brain
// store's documents retire theirs when they open (`brain/RolesRetired.ts`).

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Deletes the role table's settings row; a database without one is left as it is. */
export const RolesRetired0016 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DELETE FROM settings WHERE key = 'roleBindings'`;
});
