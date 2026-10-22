// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ProjectStore.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: one row per project, a tombstone instead of a
// delete, and at most one live project per workspace root. Changed: the row stores the wire
// `ProjectShell` whole beside the columns queries use, and only the shell store's event sink writes
// it (inside its command transaction).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import type { ProjectId } from "@cairn/protocol/Ids";
import { ProjectShell } from "@cairn/protocol/Shell";
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { shellStoreFailure } from "../shell/ShellStoreError.ts";
import type { ShellStoreError } from "../shell/ShellStoreError.ts";

/** A project as stored: its sidebar row plus its tombstone. */
export interface ProjectRow {
  readonly shell: ProjectShell;
  /** Set when the project was removed from the sidebar; the row stays so its id is never reused. */
  readonly deletedAt: Option.Option<DateTime.Utc>;
}

const StoredProject = Schema.Struct({
  deleted_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
  shell_json: Schema.fromJsonString(Schema.toCodecJson(ProjectShell)),
});

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StoredProject));

const encodeShell = Schema.encodeEffect(
  Schema.fromJsonString(Schema.toCodecJson(ProjectShell))
);

const toRow = (stored: typeof StoredProject.Type): ProjectRow => ({
  shell: stored.shell_json,
  deletedAt: stored.deleted_at,
});

/** Whether a project row is live (shown in the sidebar). */
export const isActiveProject = (row: ProjectRow) =>
  Option.isNone(row.deletedAt);

/** The project rows of `cairn.sqlite`. Writes belong to the shell store's event sink. */
export class Projects extends Context.Service<
  Projects,
  {
    /** The row for `projectId`, live or tombstoned. */
    get(
      projectId: ProjectId
    ): Effect.Effect<Option.Option<ProjectRow>, ShellStoreError>;
    /** The live project whose root is `workspaceRoot`, if any. */
    activeByWorkspaceRoot(
      workspaceRoot: string
    ): Effect.Effect<Option.Option<ProjectRow>, ShellStoreError>;
    /** Every live project, oldest first. */
    readonly listActive: Effect.Effect<
      ReadonlyArray<ProjectShell>,
      ShellStoreError
    >;
    /** Inserts or replaces a row. Call only inside the event sink's transaction. */
    write(row: ProjectRow): Effect.Effect<void, ShellStoreError>;
  }
>()("cairn/server/projects/Projects") {
  /** Reads and writes through the ambient `SqlClient`. */
  static readonly layerNoDeps = Layer.effect(
    Projects,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const get = Effect.fn("Projects.get")(function* (projectId: ProjectId) {
        const rows = yield* sql`
            SELECT deleted_at, shell_json FROM projects WHERE id = ${projectId}
          `.pipe(Effect.flatMap(decodeRows));

        return Option.map(Option.fromNullishOr(rows[0]), toRow);
      }, shellStoreFailure("Projects.get"));

      const activeByWorkspaceRoot = Effect.fn("Projects.activeByWorkspaceRoot")(
        function* (workspaceRoot: string) {
          const rows = yield* sql`
            SELECT deleted_at, shell_json FROM projects
            WHERE workspace_root = ${workspaceRoot} AND deleted_at IS NULL
          `.pipe(Effect.flatMap(decodeRows));

          return Option.map(Option.fromNullishOr(rows[0]), toRow);
        },
        shellStoreFailure("Projects.activeByWorkspaceRoot")
      );

      const listActive = sql`
        SELECT deleted_at, shell_json FROM projects
        WHERE deleted_at IS NULL ORDER BY created_at, id
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((rows) => rows.map((row) => row.shell_json)),
        shellStoreFailure("Projects.listActive"),
        Effect.withSpan("Projects.listActive")
      );

      const write = Effect.fn("Projects.write")(function* (row: ProjectRow) {
        const shellJson = yield* encodeShell(row.shell);

        const deletedAt = Option.match(row.deletedAt, {
          onNone: () => null,
          onSome: DateTime.toEpochMillis,
        });

        yield* sql`
            INSERT INTO projects (id, workspace_root, created_at, deleted_at, shell_json)
            VALUES (
              ${row.shell.id},
              ${row.shell.workspaceRoot},
              ${DateTime.toEpochMillis(row.shell.createdAt)},
              ${deletedAt},
              ${shellJson}
            )
            ON CONFLICT (id) DO UPDATE SET
              workspace_root = excluded.workspace_root,
              deleted_at = excluded.deleted_at,
              shell_json = excluded.shell_json
          `;
      }, shellStoreFailure("Projects.write"));

      return Projects.of({ get, activeByWorkspaceRoot, listActive, write });
    })
  );
}
