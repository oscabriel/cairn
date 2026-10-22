// Ported from github.com/pingdotgg/t3code, apps/server/src/orchestration-v2/ShellStream.ts
// (loadShellSnapshotParts, buildActiveShellSnapshot) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: one transaction reads the projects, the threads and the sequence, so they agree. Changed:
// one location (archived and deleted threads are not in the shell) and no schema version or
// archived list.
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
import type { ShellSnapshot as ShellSnapshotValue } from "@cairn/protocol/Shell";
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { Projects } from "../projects/Projects.ts";
import { EventStore } from "./EventStore.ts";
import { shellStoreFailure } from "./ShellStoreError.ts";
import type { ShellStoreError } from "./ShellStoreError.ts";
import { ThreadRows } from "./ThreadRows.ts";

/** Loads the whole shell as of one sequence: the first frame of a fresh subscription. */
export class ShellSnapshot extends Context.Service<
  ShellSnapshot,
  {
    /** Every live project and every thread in the shell, with the sequence they reflect. */
    readonly load: Effect.Effect<ShellSnapshotValue, ShellStoreError>;
  }
>()("cairn/server/shell/ShellSnapshot") {
  /** Reads through the shell store's rows and log. */
  static readonly layerNoDeps = Layer.effect(
    ShellSnapshot,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projects = yield* Projects;
      const threads = yield* ThreadRows;
      const eventStore = yield* EventStore;

      const load = sql
        .withTransaction(
          Effect.all({
            projects: projects.listActive,
            threads: threads.listLive,
            snapshotSequence: eventStore.latestSequence,
          })
        )
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            shellStoreFailure("ShellSnapshot.load")(Effect.fail(cause))
          ),
          Effect.map((read): ShellSnapshotValue => ({
            snapshotSequence: read.snapshotSequence,
            projects: read.projects,
            threads: read.threads.map((row) => row.shell),
          })),
          Effect.withSpan("ShellSnapshot.load")
        );

      return ShellSnapshot.of({ load });
    })
  );
}
