// Thread launches in flight: one row per `thread.launch` from its first commit until the thread's
// first message reaches the brain. Each row keeps the launch request and the phase it reached, so
// boot resumes a launch a crash or a restart interrupted, step by step, without redoing a step
// that already ran. Times are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `thread_launches`. */
export const Launches0002 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_launches (
      command_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('created', 'workspace', 'ensured')),
      input_json TEXT NOT NULL,
      from_login TEXT NOT NULL,
      cwd TEXT,
      branch TEXT,
      worktree_path TEXT,
      worktree_created INTEGER NOT NULL DEFAULT 0,
      branch_created INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
});
