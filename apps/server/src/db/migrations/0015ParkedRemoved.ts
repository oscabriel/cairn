// pi-durable 1.5 no longer parks a task, and the shell row lost the `parked` activity and its
// `parkedTaskIds` (ADR 0046). A row a brain on pi-durable 1.4 stored can still hold both, and the
// wire `ThreadShell` no longer decodes the activity, so every such row is rewritten once: a parked
// row reads `idle` (the boot reconcile then sets what the brain holds now) and the list is dropped.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Rewrites `parked` rows to `idle` and drops `parkedTaskIds` from every row. */
export const ParkedRemoved0015 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE threads
    SET shell_json = json_set(shell_json, '$.activity', 'idle')
    WHERE json_extract(shell_json, '$.activity') = 'parked'
  `;
  yield* sql`
    UPDATE threads
    SET shell_json = json_remove(shell_json, '$.parkedTaskIds')
    WHERE json_type(shell_json, '$.parkedTaskIds') IS NOT NULL
  `;
});
