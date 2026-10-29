// The reach tables' own rules (migrations 0010 and 0011), on a migrated in-memory cairn.sqlite: an
// artifact key is held by one row; a live portal holds its name and port until it is removed or
// stopped; states and stop reasons are closed sets.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";

import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Artifacts0010 } from "../db/migrations/0010Artifacts.ts";
import { Portals0011 } from "../db/migrations/0011Portals.ts";

const DbLayer = Database.layerTest({
  ...migrations,
  "0010_Artifacts": Artifacts0010,
  "0011_Portals": Portals0011,
});

const portal = (
  id: string,
  name: string,
  port: number | null,
  state: string,
  stopReason: string | null = null
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO portals (
        id, thread_id, name, url, port, command, cwd, state, unit, ttl_hours,
        opened_at, expires_at, stop_reason, updated_at
      ) VALUES (
        ${id}, ${"t"}, ${name}, ${`https://${name}.example.test`}, ${port}, ${"pnpm dev"},
        ${"/repo"}, ${state}, ${`cairn-portal-${id}`}, ${12}, ${1}, ${2}, ${stopReason}, ${1}
      )
    `;
  });

describe("reach tables", () => {
  it.effect("one row per artifact key", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const claim = (id: string, thread: string) => sql`
        INSERT INTO artifacts (id, thread_id, project_slug, name, claimed_at, updated_at)
        VALUES (${id}, ${thread}, ${"cairn"}, ${"report.html"}, ${1}, ${1})
      `;

      yield* claim("art_1", "a");
      const second = yield* Effect.exit(claim("art_2", "b"));
      assert.isTrue(Exit.isFailure(second));

      const kind = yield* Effect.exit(
        sql`UPDATE artifacts SET kind = ${"page"} WHERE id = ${"art_1"}`
      );

      assert.isTrue(Exit.isFailure(kind));
    }).pipe(Effect.provide(DbLayer))
  );

  it.effect(
    "a live portal holds its name and port; a removed one gives both back",
    () =>
      Effect.gen(function* () {
        yield* portal("p1", "main--cairn", 3101, "open");
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(portal("p2", "main--cairn", 3102, "opening"))
          )
        );
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(portal("p3", "feat--cairn", 3101, "opening"))
          )
        );

        // A stopped portal keeps its name (Start reruns it) but not its port.
        yield* portal("p4", "old--cairn", 3105, "stopped", "expired");
        yield* portal("p5", "new--cairn", 3105, "opening");
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(portal("p6", "old--cairn", 3106, "opening"))
          )
        );

        yield* portal("p7", "gone--cairn", 3107, "removed", "closed");
        yield* portal("p8", "gone--cairn", 3107, "open");
      }).pipe(Effect.provide(DbLayer))
  );

  it.effect("states and stop reasons are closed sets", () =>
    Effect.gen(function* () {
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(portal("q1", "a--b", 3201, "lit")))
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(portal("q2", "c--d", 3202, "stopped", "crashed"))
        )
      );
    }).pipe(Effect.provide(DbLayer))
  );
});
