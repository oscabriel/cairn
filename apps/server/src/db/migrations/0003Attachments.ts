// Uploaded attachments and the turns that claimed them. A row in `attachments` is written once, after
// the upload's bytes are stored and prepared, so a row always names files that exist. A claim ties
// an attachment to the turn that sent it; unclaimed rows older than a day are swept with their files.
// Times are epoch milliseconds.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Creates `attachments` and `attachment_claims`. */
export const Attachments0003 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'pdf', 'docx', 'file')),
      prepared_mime_type TEXT,
      pages INTEGER,
      text_chars INTEGER,
      text_truncated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE attachment_claims (
      attachment_id TEXT PRIMARY KEY REFERENCES attachments (id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL
    )
  `;

  yield* sql`CREATE INDEX attachments_created_at ON attachments (created_at)`;
});
