// The reach index of published artifacts (ADR 0038, docs/phase-2/notes/reach.md R3 and R4): one row
// per page Cairn published through porch, keyed by `(project_slug, name)`, the path porch copies it
// to under the artifacts folder. porch's own registry is what Caddy serves; this table is the
// thread's index into it and the proof of ownership: Cairn refuses to publish over a file at a key
// it holds no row for (`reach/ArtifactPublisher.ts`), because porch would overwrite it.
//
// A row is claimed (`claimed_at`, no `hash`) before porch runs and filled in after, so a crash
// between the two leaves the key Cairn's and the rerun republishes in place. Times are epoch
// milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `artifacts`. */
export const Artifacts0010 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      project_slug TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('file', 'folder')),
      url TEXT,
      hash TEXT,
      bytes INTEGER,
      claimed_at INTEGER NOT NULL,
      published_at INTEGER,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      UNIQUE (project_slug, name)
    )
  `;
  yield* sql`CREATE INDEX artifacts_thread ON artifacts (thread_id)`;
});
