// One life of the artifacts kill judge (`judges/artifacts-kill.ts`): Cairn's `Artifacts` over the
// real porch binary, a `cairn.sqlite` file and a data folder in the judge's scratch root, running
// one call and printing one JSON line. With `CAIRN_JUDGE_FAULT=artifact:after-<step>` it kills
// itself with SIGKILL right after that step (`judgeArtifactFaults`), once per marker file.
//
//   node judges/fixtures/reach/ArtifactBrain.ts '<life json>'
//
// Actions: `publish` and `revoke` call the service as the replay-safe tools do; `rows` prints the
// project's artifact rows as stored, hash-less claims included.

import path from "node:path";

import { ArtifactId } from "@cairn/protocol/Reach";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Duration, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../../../apps/server/src/Config.ts";
import { Database } from "../../../apps/server/src/db/Database.ts";
import { migrations } from "../../../apps/server/src/db/Migrations.ts";
import { judgeArtifactFaults } from "../../../apps/server/src/reach/ArtifactFaults.ts";
import {
  ArtifactPublisher,
  artifactIdOf,
} from "../../../apps/server/src/reach/ArtifactPublisher.ts";
import { Artifacts } from "../../../apps/server/src/reach/Artifacts.ts";
import { THREAD_A } from "../../../apps/server/src/reach/ArtifactScenarios.ts";
import {
  PorchClient,
  PorchSettings,
} from "../../../apps/server/src/reach/PorchClient.ts";

/** What one life does, as the judge passes it. */
export const ArtifactLife = Schema.Struct({
  action: Schema.Literals(["publish", "revoke", "rows"]),
  porch: Schema.String,
  /** The scratch root: `home`, `cfg`, `state`, `data` and `thread` sit under it. */
  root: Schema.String,
  project: Schema.String,
  name: Schema.String,
  fault: Schema.String,
  marker: Schema.String,
});

export type ArtifactLife = typeof ArtifactLife.Type;

const decodeLife = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArtifactLife)
);

const life = Effect.gen(function* () {
  const spec = yield* decodeLife(process.argv[2] ?? "");
  const dir = (name: string) => path.join(spec.root, name);

  const layer = Artifacts.layer.pipe(
    Layer.provideMerge(ArtifactPublisher.layer),
    Layer.provideMerge(PorchClient.layer),
    Layer.provideMerge(
      Database.layer({
        filename: path.join(dir("data"), "cairn.sqlite"),
        migrations,
      })
    ),
    Layer.provideMerge(ServerConfig.layerWith({ dataDir: dir("data") })),
    Layer.provideMerge(judgeArtifactFaults(spec.fault, spec.marker)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.succeed(PorchSettings, {
        bin: spec.porch,
        env: {
          HOME: dir("home"),
          XDG_CONFIG_HOME: dir("cfg"),
          XDG_STATE_HOME: dir("state"),
        },
        timeout: Duration.seconds(30),
      })
    )
  );

  const answer = yield* Effect.gen(function* () {
    const artifacts = yield* Artifacts;

    if (spec.action === "publish") {
      const published = yield* artifacts.publish({
        threadId: THREAD_A,
        projectId: Option.none(),
        cwd: dir("thread"),
        path: spec.name,
        name: Option.none(),
        project: Option.some(spec.project),
      });

      return { ok: true, changed: published.changed };
    }

    if (spec.action === "revoke") {
      const id = yield* Schema.decodeEffect(ArtifactId)(
        artifactIdOf(spec.project, spec.name)
      );

      const row = yield* artifacts.revoke(id, Option.some(THREAD_A));

      return { ok: true, revoked: Option.isSome(row.revokedAt) };
    }

    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`
      SELECT name, hash, revoked_at FROM artifacts WHERE project_slug = ${spec.project}
      ORDER BY name
    `;

    return { ok: true, rows };
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({ ok: false, error: error.message })
    ),
    Effect.provide(layer)
  );

  yield* Console.log(JSON.stringify(answer));
});

NodeRuntime.runMain(life);
