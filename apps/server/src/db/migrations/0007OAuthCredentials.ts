// Cairn's own OAuth sign-ins (ADR 0009, ADR 0037): one row per provider Cairn logs in to itself,
// today only `openai-codex`. `credential_json` is pi-ai's `OAuthCredential` as JSON (access and
// refresh tokens, expiry, the provider's extra fields such as Codex's `accountId`); it is written
// only by the process that holds the OAuth lock (`models/OAuthStore.ts`). `signed_in_at` is the
// last sign-in, `refreshed_at` the last token refresh (null until the first), `updated_at` the last
// write of either. Times are epoch milliseconds. pi's own `~/.pi/agent/auth.json` is never read for
// these providers and never written.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `oauth_credentials`. */
export const OAuthCredentials0007 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE oauth_credentials (
      provider_id TEXT PRIMARY KEY,
      credential_json TEXT NOT NULL,
      signed_in_at INTEGER NOT NULL,
      refreshed_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `;
});
