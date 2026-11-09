// Command receipts are pruned by age (`shell/EventStore.ts` prune, ADR 0045): the oldest expired
// receipts are found through this index instead of a walk over every younger one.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Indexes `command_receipts.accepted_at`. */
export const CommandReceiptAge0014 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX command_receipts_accepted_at ON command_receipts (accepted_at)`;
});
