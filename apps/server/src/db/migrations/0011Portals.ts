// Portals (ADR 0038, docs/phase-2/notes/reach.md R3 and R5): a dev server served at
// `https://<name>.<domain>`, run as the transient user unit `unit` (`cairn-portal-<id>`) behind a
// porch of the same name. A row moves `opening` → `open` → `stopped` → `removed`; `stopped` keeps
// the name and command so Start can run it again. Boot repair reconciles rows, units and porches.
//
// While a portal is not `removed` its name is its own, and while it is `opening` or `open` so is
// its port: Cairn picks the port itself, since the installed porch has no lease command. Times
// are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `portals`. */
export const Portals0011 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE portals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      port INTEGER CHECK (port IS NULL OR (port > 0 AND port < 65536)),
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      state TEXT NOT NULL
        CHECK (state IN ('opening', 'open', 'stopped', 'removed')),
      arms TEXT NOT NULL DEFAULT 'host' CHECK (arms IN ('host', 'stone')),
      stone_id TEXT,
      unit TEXT NOT NULL,
      ttl_hours INTEGER NOT NULL CHECK (ttl_hours > 0 AND ttl_hours <= 72),
      opened_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      stopped_at INTEGER,
      stop_reason TEXT CHECK (
        stop_reason IS NULL
        OR stop_reason IN ('closed', 'expired', 'exited', 'lost')
      ),
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX portals_live_name ON portals (name)
    WHERE state <> 'removed'
  `;
  yield* sql`
    CREATE UNIQUE INDEX portals_live_port ON portals (port)
    WHERE port IS NOT NULL AND state IN ('opening', 'open')
  `;
  yield* sql`CREATE INDEX portals_thread ON portals (thread_id)`;
  yield* sql`CREATE INDEX portals_state ON portals (state)`;
});
