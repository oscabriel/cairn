// Child workspaces (docs/phase-2/notes/subagents.md section 6): the worktree a writing subagent
// works in, one row per child thread. The row is written before `git worktree add` runs, with the
// branch and path already chosen from the child's thread id, so a spawn that a crash interrupted
// finds the same plan when it reruns, and the boot repair can find a worktree whose spawn never
// landed. `worktree_created` and `branch_created` are set only after git says it made them.
//
// `state` moves `planned` → `ready` → `released`. `base_sha` is the commit the worktree started
// from; `base_ref` is what "merged" is judged against at release (the parent's branch, the brief's
// base, or the sha itself when the parent was detached). Times are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `child_workspaces`. */
export const ChildWorkspaces0012 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE child_workspaces (
      child_thread_id TEXT PRIMARY KEY,
      parent_thread_id TEXT NOT NULL,
      repo_root TEXT NOT NULL,
      worktree_path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('planned', 'ready', 'released')),
      worktree_created INTEGER NOT NULL DEFAULT 0,
      branch_created INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX child_workspaces_parent ON child_workspaces (parent_thread_id)
  `;
});
