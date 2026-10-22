// Cairn's one Executor grant (plan D39): pi-mcp's OAuth state for the scoped connection the user
// made for Cairn, imported once from `~/.config/cairn/executor-grant.json` and kept here after.
// One row (`id = 1`). `oauth_state` is the grant as JSON (server URL, client, tokens and the
// sign-in fields); `client_redirect_url` is the redirect the stored client was registered with, so
// a sign-in from Cairn's own callback knows when it must register a new client; `pending_state`
// and `pending_at` hold the one sign-in in flight (single use, 10 minutes). The second table keeps
// each time the grant fell into needs-sign-in, so a notifier can tell the user exactly once. Times
// are epoch milliseconds.
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `executor_grant` and `executor_sign_in_needed`. */
export const Executor0004 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE executor_grant (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      server_url TEXT NOT NULL,
      oauth_state TEXT NOT NULL,
      client_redirect_url TEXT,
      pending_state TEXT,
      pending_at INTEGER,
      imported_at INTEGER,
      signed_in_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE executor_sign_in_needed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      detail TEXT NOT NULL,
      notified_at INTEGER
    )
  `;
});
