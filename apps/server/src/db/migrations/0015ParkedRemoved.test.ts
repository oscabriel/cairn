// Migration 0015 (ADR 0046): a thread row a brain on pi-durable 1.4 stored as `parked`, with its
// `parkedTaskIds`, reads as an `idle` row of today's `ThreadShell`; every other row keeps its
// activity.

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ThreadRows } from "../../shell/ThreadRows.ts";
import { Database } from "../Database.ts";
import { Shell0001 } from "./0001Shell.ts";
import { ParkedRemoved0015 } from "./0015ParkedRemoved.ts";

const encodeRow = Schema.encodeSync(
  Schema.fromJsonString(Schema.toCodecJson(ThreadShell))
);

const layer = ThreadRows.layerNoDeps.pipe(
  Layer.provideMerge(Database.layerTest({ "0001_Shell": Shell0001 }))
);

describe("migration 0015", () => {
  it.effect("reads a parked row as idle and drops every parked task list", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`INSERT INTO projects (id, workspace_root, created_at, shell_json) VALUES ('prj_1', '/repo', 0, '{}')`;

      for (const [n, activity] of [
        [1, "parked"],
        [2, "running"],
      ] as const) {
        const row = shellRow(n);

        // As a 1.4 brain wrote it: today's fields, its activity and a parked task list.
        yield* sql`
          INSERT INTO threads (id, project_id, created_at, updated_at, shell_json)
          VALUES (
            ${row.id}, 'prj_1', 0, 0,
            json_set(${encodeRow(row)}, '$.activity', ${activity}, '$.parkedTaskIds', json('[7]'))
          )
        `;
      }

      yield* ParkedRemoved0015;

      const rows = yield* ThreadRows;
      const parked = yield* rows.get(shellRow(1).id);
      const running = yield* rows.get(shellRow(2).id);

      assert.deepStrictEqual(
        Option.map(parked, (row) => row.shell.activity),
        Option.some("idle")
      );
      assert.deepStrictEqual(
        Option.map(running, (row) => row.shell.activity),
        Option.some("running")
      );

      const left = yield* sql<{
        readonly n: number;
      }>`SELECT count(*) AS n FROM threads WHERE json_type(shell_json, '$.parkedTaskIds') IS NOT NULL`;

      assert.strictEqual(left[0]?.n, 0);
    }).pipe(Effect.provide(layer))
  );
});
