// Artifacts over the fake porch: every artifact scenario (`ArtifactScenarios.ts`, the same ones
// `judges/reach.ts` runs on the real binary) with its broken control failing, then what only the
// service sees: the project slug, the size cap, the owner-only staging folder, a rerun after a
// crash between the claim and porch, and `reach.list` with a portal row beside the artifacts.

import path from "node:path";

import { ProjectId } from "@cairn/protocol/Ids";
import { ProjectShell } from "@cairn/protocol/Shell";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
} from "effect";
import { SqlClient } from "effect/sql";

import { ServerConfig } from "../Config.ts";
import { Database } from "../db/Database.ts";
import { migrations } from "../db/Migrations.ts";
import { Projects } from "../projects/Projects.ts";
import { ArtifactPublisher, artifactIdOf } from "./ArtifactPublisher.ts";
import { Artifacts, projectSlugOf } from "./Artifacts.ts";
import {
  artifactScenarios,
  overwriteControl,
  SCENARIO_PROJECT,
  THREAD_A,
} from "./ArtifactScenarios.ts";
import type { ArtifactStage } from "./ArtifactScenarios.ts";
import { makeFakePorch, PorchClient } from "./PorchClient.ts";
import { ReachLister } from "./ReachList.ts";

const DOMAIN = "example.test";

/** A fresh fake porch, thread folders and data folder under one temp root, and the layers. */
const fakeStage = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;

  const made = yield* fs.makeTempDirectoryScoped({
    prefix: "cairn-artifacts-",
  });

  const root = yield* fs.realPath(made);

  const dirs = {
    artifacts: path.join(root, "artifacts"),
    cwd: path.join(root, "thread-a"),
    otherCwd: path.join(root, "thread-b"),
    outside: path.join(root, "outside"),
    data: path.join(root, "data"),
  };

  for (const dir of Object.values(dirs)) {
    yield* fs.makeDirectory(dir);
  }

  const fake = yield* makeFakePorch({
    domain: DOMAIN,
    artifacts: dirs.artifacts,
  });

  const stage: ArtifactStage = {
    domain: DOMAIN,
    artifacts: dirs.artifacts,
    cwd: dirs.cwd,
    otherCwd: dirs.otherCwd,
    outside: dirs.outside,
  };

  const layer = ReachLister.layerNoDeps.pipe(
    Layer.provideMerge(Artifacts.layer),
    Layer.provideMerge(ArtifactPublisher.layer),
    Layer.provideMerge(Layer.succeed(PorchClient, fake.client)),
    Layer.provideMerge(Projects.layerNoDeps),
    Layer.provideMerge(Database.layerTest(migrations)),
    Layer.provideMerge(ServerConfig.layerWith({ dataDir: dirs.data })),
    Layer.provideMerge(NodeServices.layer)
  );

  return { stage, layer, dirs };
});

const request = (stage: ArtifactStage, relative: string) => ({
  threadId: THREAD_A,
  projectId: Option.none<ProjectId>(),
  cwd: stage.cwd,
  path: relative,
  name: Option.none<string>(),
  project: Option.some(SCENARIO_PROJECT),
});

describe("Artifacts over the fake porch", () => {
  it.live("holds every artifact scenario", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer } = yield* fakeStage;

        for (const each of artifactScenarios) {
          const exit = yield* Effect.exit(
            each.run(stage).pipe(Effect.provide(layer))
          );

          assert.isTrue(
            Exit.isSuccess(exit),
            `${each.name}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`
          );
        }
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("the overwrite control fails: porch alone overwrites", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer } = yield* fakeStage;

        const exit = yield* Effect.exit(
          overwriteControl.run(stage).pipe(Effect.provide(layer))
        );

        assert.isTrue(Exit.isFailure(exit));
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live(
    "stages owner-only, refuses an oversize source, and reruns over a crashed claim",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { stage, layer, dirs } = yield* fakeStage;

          yield* Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const sql = yield* SqlClient.SqlClient;
            const artifacts = yield* Artifacts;

            // A crash after the claim and mid-copy: a row with no hash and a torn staged file.
            const now = 1;
            yield* sql`
              INSERT INTO artifacts (id, thread_id, project_slug, name, claimed_at, updated_at)
              VALUES (${artifactIdOf(SCENARIO_PROJECT, "torn.html")}, ${THREAD_A},
                ${SCENARIO_PROJECT}, ${"torn.html"}, ${now}, ${now})
            `;

            const staged = path.join(
              dirs.data,
              "artifacts",
              THREAD_A,
              SCENARIO_PROJECT,
              "torn.html"
            );

            yield* fs.makeDirectory(path.dirname(staged), { recursive: true });
            yield* fs.writeFileString(staged, "<p>to");
            yield* fs.writeFileString(
              path.join(stage.cwd, "torn.html"),
              "<p>torn</p>\n"
            );

            const rerun = yield* artifacts.publish(request(stage, "torn.html"));
            assert.isTrue(rerun.changed);
            assert.strictEqual(
              yield* fs.readFileString(
                path.join(stage.artifacts, SCENARIO_PROJECT, "torn.html")
              ),
              "<p>torn</p>\n"
            );

            const staging = yield* fs.stat(path.join(dirs.data, "artifacts"));
            assert.strictEqual(staging.mode % 0o1000, 0o700);

            const threadFolder = yield* fs.stat(
              path.join(dirs.data, "artifacts", THREAD_A)
            );

            assert.strictEqual(threadFolder.mode % 0o1000, 0o700);

            const big = path.join(stage.cwd, "big.html");
            yield* fs.writeFileString(big, "");
            yield* fs.truncate(big, 26 * 1024 * 1024);

            const refused = yield* Effect.flip(
              artifacts.publish(request(stage, "big.html"))
            );

            assert.isTrue(
              Predicate.isTagged(refused, "ArtifactRefused") &&
                refused.reason === "too-large"
            );
          }).pipe(Effect.provide(layer));
        })
      ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("defaults the project to the thread's, or refuses without one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer } = yield* fakeStage;

        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const projects = yield* Projects;
          const artifacts = yield* Artifacts;
          const projectId = ProjectId.make("prj_site");

          const shell = yield* Schema.decodeEffect(ProjectShell)({
            id: projectId,
            title: "My Site",
            kind: "folder",
            workspaceRoot: "/home/someone/Developer/projects/My Site",
            repository: null,
            defaultModel: null,
            createdAt: DateTime.makeUnsafe(0),
            updatedAt: DateTime.makeUnsafe(0),
          });

          yield* projects.write({ shell, deletedAt: Option.none() });
          yield* fs.writeFileString(
            path.join(stage.cwd, "home.html"),
            "<p>h</p>\n"
          );

          const published = yield* artifacts.publish({
            ...request(stage, "home.html"),
            projectId: Option.some(projectId),
            project: Option.none(),
          });

          assert.strictEqual(published.row.projectSlug, "my-site");
          assert.strictEqual(
            published.row.url,
            `https://plans.${DOMAIN}/my-site/home.html`
          );

          const refused = yield* Effect.flip(
            artifacts.publish({
              ...request(stage, "home.html"),
              project: Option.none(),
            })
          );

          assert.isTrue(
            Predicate.isTagged(refused, "ArtifactRefused") &&
              refused.reason === "project"
          );
        }).pipe(Effect.provide(layer));
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );

  it.live("reach.list answers artifacts and live portals, per thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { stage, layer } = yield* fakeStage;

        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sql = yield* SqlClient.SqlClient;
          const artifacts = yield* Artifacts;
          const lister = yield* ReachLister;

          yield* fs.writeFileString(
            path.join(stage.cwd, "a.html"),
            "<p>a</p>\n"
          );
          yield* artifacts.publish(request(stage, "a.html"));

          const portal = (id: string, name: string, state: string) => sql`
            INSERT INTO portals (
              id, thread_id, name, url, port, command, cwd, state, unit, ttl_hours,
              opened_at, expires_at, updated_at
            ) VALUES (
              ${id}, ${THREAD_A}, ${name}, ${`https://${name}.${DOMAIN}`}, ${null},
              ${"pnpm dev"}, ${stage.cwd}, ${state}, ${`cairn-portal-${id}`}, ${12}, ${1}, ${2}, ${1}
            )
          `;

          yield* portal("prt_open", "main--site", "open");
          yield* portal("prt_gone", "old--site", "removed");

          const mine = yield* lister.list(Option.some(THREAD_A));
          assert.deepStrictEqual(
            mine.artifacts.map((row) => row.name),
            ["a.html"]
          );
          assert.deepStrictEqual(
            mine.portals.map((row) => [row.name, row.state]),
            [["main--site", "open"]]
          );
          assert.deepStrictEqual(
            mine.portals.map((row) => DateTime.toEpochMillis(row.expiresAt)),
            [2]
          );

          const everyone = yield* lister.list(Option.none());
          assert.strictEqual(everyone.artifacts.length, 1);
        }).pipe(Effect.provide(layer));
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});

const folder = (workspaceRoot: string) =>
  projectSlugOf({ kind: "folder", workspaceRoot });

describe("Artifacts.layerTest", () => {
  it.live("publishes through its own fake porch and temp folders", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "cairn-artifacts-cwd-" })
        );

        yield* fs.writeFileString(path.join(cwd, "page.html"), "<p>p</p>\n");

        const published = yield* Effect.gen(function* () {
          const artifacts = yield* Artifacts;

          return yield* artifacts.publish({
            threadId: THREAD_A,
            projectId: Option.none(),
            cwd,
            path: "page.html",
            name: Option.none(),
            project: Option.some(SCENARIO_PROJECT),
          });
        }).pipe(Effect.provide(Artifacts.layerTest));

        assert.strictEqual(
          published.row.url,
          `https://plans.${DOMAIN}/${SCENARIO_PROJECT}/page.html`
        );
      })
    ).pipe(Effect.provide(NodeServices.layer))
  );
});

describe(projectSlugOf, () => {
  it("names a folder project by its root and a scratch project scratch", () => {
    assert.strictEqual(folder("/home/u/Developer/projects/cairn"), "cairn");
    assert.strictEqual(folder("/home/u/My Site!"), "my-site-");
    assert.strictEqual(folder("/home/u/..hidden"), "hidden");
    assert.strictEqual(folder("/"), "scratch");
    assert.strictEqual(
      projectSlugOf({ kind: "scratch", workspaceRoot: "/data/scratch" }),
      "scratch"
    );
  });
});
