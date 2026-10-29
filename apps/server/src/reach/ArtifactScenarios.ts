// The artifact rules as scenarios, run on two stages: `Artifacts.test.ts` runs them over the fake
// porch, and `judges/reach.ts` over the real binary against a throwaway Caddy. Each scenario uses
// its own page names, so one stage runs them all in turn over one database and folder.
//
// They hold what docs/phase-2/notes/reach.md R4 asks of the artifact tools: a publish answers the
// page's URL with the source's bytes on disk; the same bytes again are `changed: false` at the
// same URL; an edit is `changed: true` at the same URL; another thread's name is refused; a file
// Cairn did not publish is never overwritten; secrets, links out of the thread's folder and paths
// outside it are refused before anything is copied; a project that climbs is refused before it
// names a path; a revoke removes the page, revoking again touches nothing, and a republish brings
// it back. `overwriteControl` is the broken control: it publishes straight through porch
// over a hand-written file, as Cairn would without its rule, and must fail.

import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { Effect, FileSystem, Option, Predicate, Schema } from "effect";

import { Artifacts, outcomeOf } from "./Artifacts.ts";
import type { PublishRequest } from "./Artifacts.ts";
import { PorchClient } from "./PorchClient.ts";

/** Where one stage's porch and thread live. */
export interface ArtifactStage {
  readonly domain: string;
  /** porch's artifacts folder. */
  readonly artifacts: string;
  /** Thread A's folder (an empty folder the scenarios write into). */
  readonly cwd: string;
  /** Thread B's folder. */
  readonly otherCwd: string;
  /** A folder outside both threads' folders. */
  readonly outside: string;
  /** The brain's data folder (`ServerConfig.dataDir`), which holds the staging folder. */
  readonly data: string;
}

/** A scenario's check did not hold. */
export class ArtifactScenarioFailure extends Schema.TaggedError<ArtifactScenarioFailure>()(
  "ArtifactScenarioFailure",
  { message: Schema.String }
) {}

const expect = (condition: boolean, message: string) =>
  condition
    ? Effect.void
    : Effect.fail(new ArtifactScenarioFailure({ message }));

/** Runs `effect` and answers its failure, failing the scenario if it succeeded. */
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>, what: string) =>
  effect.pipe(
    Effect.flip,
    Effect.mapError(
      () =>
        new ArtifactScenarioFailure({
          message: `${what} succeeded; it should be refused`,
        })
    )
  );

/** The project every scenario publishes under. */
export const SCENARIO_PROJECT = "judge";

/** The thread most scenarios publish from, in `ArtifactStage.cwd`. */
export const THREAD_A = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-0000000a3e01");

/** The other thread, in `ArtifactStage.otherCwd`, whose names collide with thread A's. */
export const THREAD_B = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-0000000b3e02");

/** One check; any unexpected failure becomes an `ArtifactScenarioFailure` naming it. */
export interface ArtifactScenario<R> {
  readonly name: string;
  run(
    stage: ArtifactStage
  ): Effect.Effect<void, ArtifactScenarioFailure, R | FileSystem.FileSystem>;
}

const scenario = <R, E extends { readonly message: string }>(
  name: string,
  body: (
    stage: ArtifactStage
  ) => Effect.Effect<void, E, R | FileSystem.FileSystem>
): ArtifactScenario<R> => ({
  name,
  run: (stage) =>
    body(stage).pipe(
      Effect.mapError((failure) =>
        Predicate.isTagged(failure, "ArtifactScenarioFailure")
          ? new ArtifactScenarioFailure({ message: failure.message })
          : new ArtifactScenarioFailure({
              message: `unexpected failure: ${failure.message}`,
            })
      )
    ),
});

const write = (folder: string, relative: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(folder, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);

    return file;
  });

const readServed = (stage: ArtifactStage, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(
      path.join(stage.artifacts, SCENARIO_PROJECT, relative)
    );
  });

const servedExists = (stage: ArtifactStage, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.exists(
      path.join(stage.artifacts, SCENARIO_PROJECT, relative)
    );
  });

/** A request from thread A (or `thread`) for `relative`, under the scenario project. */
const ask = (
  stage: ArtifactStage,
  relative: string,
  options: {
    readonly thread?: ThreadId;
    readonly name?: string;
  } = {}
): PublishRequest => {
  const thread = options.thread ?? THREAD_A;

  return {
    threadId: thread,
    projectId: Option.none(),
    cwd: thread === THREAD_A ? stage.cwd : stage.otherCwd,
    path: relative,
    name: Option.fromUndefinedOr(options.name),
    project: Option.some(SCENARIO_PROJECT),
  };
};

const urlOf = (stage: ArtifactStage, name: string) =>
  `https://plans.${stage.domain}/${SCENARIO_PROJECT}/${name}`;

/** The artifact rules over `Artifacts`. */
export const artifactScenarios: ReadonlyArray<
  ArtifactScenario<Artifacts | PorchClient>
> = [
  scenario("publish, republish unchanged, edit in place", (stage) =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      yield* write(stage.cwd, "out/report.html", "<p>one</p>\n");

      const first = yield* artifacts.publish(ask(stage, "out/report.html"));
      yield* expect(
        outcomeOf(first) === "published",
        `a first publish is ${outcomeOf(first)}`
      );
      yield* expect(
        first.row.url === urlOf(stage, "report.html"),
        `url ${first.row.url}, expected ${urlOf(stage, "report.html")}`
      );
      yield* expect(
        (yield* readServed(stage, "report.html")) === "<p>one</p>\n",
        "the served copy holds the source's bytes"
      );

      const again = yield* artifacts.publish(ask(stage, "out/report.html"));
      yield* expect(
        outcomeOf(again) === "unchanged" && again.row.url === first.row.url,
        `the same bytes again are ${outcomeOf(again)} at ${again.row.url}`
      );

      // Written somewhere else in the thread's folder: the same name updates the same page.
      yield* write(stage.cwd, "elsewhere/report.html", "<p>two</p>\n");

      const edited = yield* artifacts.publish(
        ask(stage, "elsewhere/report.html")
      );

      yield* expect(
        outcomeOf(edited) === "updated" && edited.row.url === first.row.url,
        `an edit is ${outcomeOf(edited)} at ${edited.row.url}`
      );
      yield* expect(
        (yield* readServed(stage, "report.html")) === "<p>two</p>\n",
        "the served copy holds the edit"
      );
    })
  ),
  scenario("a name another thread holds is refused", (stage) =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      yield* write(stage.cwd, "shared.html", "<p>a</p>\n");
      yield* write(stage.otherCwd, "shared.html", "<p>b</p>\n");
      yield* artifacts.publish(ask(stage, "shared.html"));

      const error = yield* refusal(
        artifacts.publish(ask(stage, "shared.html", { thread: THREAD_B })),
        "thread B publishing thread A's name"
      );

      yield* expect(
        Predicate.isTagged(error, "ArtifactPublishError") &&
          error.reason === "taken",
        `refused ${error._tag}, expected ArtifactPublishError taken`
      );
      yield* expect(
        (yield* readServed(stage, "shared.html")) === "<p>a</p>\n",
        "thread A's page is intact"
      );
    })
  ),
  scenario("a file Cairn did not publish is never overwritten", (stage) =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const hand = "<p>written by hand</p>\n";
      yield* write(
        path.join(stage.artifacts, SCENARIO_PROJECT),
        "plan.html",
        hand
      );
      yield* write(stage.cwd, "plan.html", "<p>agent</p>\n");

      const error = yield* refusal(
        artifacts.publish(ask(stage, "plan.html")),
        "publishing over a hand-written page"
      );

      yield* expect(
        Predicate.isTagged(error, "ArtifactPublishError") &&
          error.reason === "unmanaged",
        `refused ${error._tag}, expected ArtifactPublishError unmanaged`
      );
      yield* expect(
        (yield* readServed(stage, "plan.html")) === hand,
        "the hand-written page is intact"
      );

      // Under another name it goes ahead.
      const renamed = yield* artifacts.publish(
        ask(stage, "plan.html", { name: "agent-plan.html" })
      );

      yield* expect(
        renamed.row.url === urlOf(stage, "agent-plan.html"),
        `renamed url ${renamed.row.url}`
      );
    })
  ),
  scenario("a folder publishes with a trailing slash", (stage) =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      yield* write(stage.cwd, "site/index.html", "<p>site</p>\n");
      yield* write(stage.cwd, "site/style.css", "p{}\n");

      const site = yield* artifacts.publish(ask(stage, "site"));
      yield* expect(
        site.row.kind === "folder" &&
          site.row.url === `${urlOf(stage, "site")}/` &&
          site.row.bytes === "<p>site</p>\n".length + "p{}\n".length,
        `folder row ${site.row.kind} ${site.row.url} ${String(site.row.bytes)}`
      );
      yield* expect(
        (yield* readServed(stage, "site/style.css")) === "p{}\n",
        "every file of the folder is served"
      );
    })
  ),
  scenario(
    "secrets, links and paths outside are refused before a copy",
    (stage) =>
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        const fs = yield* FileSystem.FileSystem;
        yield* write(stage.cwd, "leaky/index.html", "<p>x</p>\n");
        yield* write(stage.cwd, "leaky/.env.local", "TOKEN=x\n");
        yield* write(stage.cwd, "gitty/index.html", "<p>x</p>\n");
        yield* write(stage.cwd, "gitty/.git/HEAD", "ref\n");
        yield* write(stage.cwd, "linky/index.html", "<p>x</p>\n");
        yield* write(stage.cwd, ".git/config", "[remote]\n");
        yield* write(stage.cwd, "node_modules/x/README.md", "x\n");
        yield* write(stage.cwd, ".ssh/notes.html", "<p>k</p>\n");
        yield* write(stage.cwd, "deep/.hidden/page.html", "<p>h</p>\n");
        const secret = yield* write(stage.outside, "secret.html", "<p>s</p>\n");
        yield* fs.symlink(secret, path.join(stage.cwd, "linky", "secret.html"));
        yield* fs.symlink(secret, path.join(stage.cwd, "escape.html"));

        const cases: ReadonlyArray<readonly [string, string, string]> = [
          ["leaky", "secret", "leaky/.env.local"],
          ["gitty", "secret", "gitty/.git"],
          ["linky", "symlink", "linky/secret.html"],
          ["escape.html", "outside", "escape.html"],
          [".git/config", "secret", ".git/config"],
          ["node_modules/x/README.md", "secret", "node_modules/x/README.md"],
          [".ssh/notes.html", "secret", ".ssh/notes.html"],
          ["deep/.hidden/page.html", "secret", "deep/.hidden/page.html"],
          [secret, "outside", secret],
          ["../nothing-here.html", "missing", "../nothing-here.html"],
        ];

        for (const [asked, reason, at] of cases) {
          const error = yield* refusal(
            artifacts.publish(ask(stage, asked)),
            `publishing ${asked}`
          );

          yield* expect(
            Predicate.isTagged(error, "ArtifactRefused") &&
              error.reason === reason &&
              error.path.startsWith(at),
            `${asked}: refused ${error._tag} ${Predicate.isTagged(error, "ArtifactRefused") ? `${error.reason} at ${error.path}` : error.message}, expected ${reason} at ${at}`
          );
        }

        for (const name of [
          "leaky",
          "gitty",
          "linky",
          "escape.html",
          "secret.html",
          "config",
          "README.md",
          "notes.html",
          "page.html",
        ]) {
          yield* expect(
            !(yield* servedExists(stage, name)),
            `${name} reached the artifacts folder`
          );
        }

        const badName = yield* refusal(
          artifacts.publish(ask(stage, "leaky/index.html", { name: ".env" })),
          "a page named .env"
        );

        yield* expect(
          Predicate.isTagged(badName, "ArtifactRefused") &&
            badName.reason === "name",
          `a page named .env refused ${badName._tag}`
        );
      })
  ),
  scenario(
    "revoke removes the page; again is a no-op; republish serves it",
    (stage) =>
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        yield* write(stage.cwd, "gone.html", "<p>gone</p>\n");
        const published = yield* artifacts.publish(ask(stage, "gone.html"));

        const notMine = yield* refusal(
          artifacts.revoke(published.row.id, Option.some(THREAD_B)),
          "thread B revoking thread A's page"
        );

        yield* expect(
          Predicate.isTagged(notMine, "ArtifactNotFound"),
          `another thread's revoke refused ${notMine._tag}`
        );

        const revoked = yield* artifacts.revoke(
          published.row.id,
          Option.some(THREAD_A)
        );

        yield* expect(
          Option.isSome(revoked.revokedAt),
          "the row is marked revoked"
        );
        yield* expect(
          !(yield* servedExists(stage, "gone.html")),
          "the page is no longer in the artifacts folder"
        );

        const twice = yield* artifacts.revoke(published.row.id, Option.none());
        yield* expect(
          Option.isSome(twice.revokedAt),
          "revoking again still answers the revoked row"
        );

        // Once revoked, a file at the target is somebody else's: revoking again leaves it.
        const fs = yield* FileSystem.FileSystem;
        const hand = "<p>the user's own gone.html</p>\n";

        const handFile = yield* write(
          path.join(stage.artifacts, SCENARIO_PROJECT),
          "gone.html",
          hand
        );

        yield* artifacts.revoke(published.row.id, Option.some(THREAD_A));
        yield* expect(
          (yield* readServed(stage, "gone.html")) === hand,
          "revoking a revoked page again removed a file Cairn did not write"
        );
        yield* fs.remove(handFile);

        const listed = yield* artifacts.list(Option.some(THREAD_A));
        yield* expect(
          listed.some(
            (row) => row.name === "gone.html" && Option.isSome(row.revokedAt)
          ),
          "the list shows the page revoked"
        );

        const back = yield* artifacts.publish(ask(stage, "gone.html"));
        yield* expect(
          Option.isNone(back.row.revokedAt) &&
            back.row.url === published.row.url &&
            (yield* readServed(stage, "gone.html")) === "<p>gone</p>\n",
          "a republish serves the page again at the same URL"
        );

        const otherThread = yield* artifacts.list(Option.some(THREAD_B));
        yield* expect(
          !otherThread.some((row) => row.name === "gone.html"),
          "thread B's list does not show thread A's page"
        );
      })
  ),
  scenario("a climbing project is refused before any path is built", (stage) =>
    Effect.gen(function* () {
      const artifacts = yield* Artifacts;
      const fs = yield* FileSystem.FileSystem;
      yield* write(stage.cwd, "climb.html", "<p>climb</p>\n");

      // Where the staging path would land if the project were joined in unchecked.
      const threadStaging = path.join(stage.data, "artifacts", THREAD_A);
      const planted = yield* write(stage.outside, "victim/keep.txt", "keep\n");
      const climb = path.relative(threadStaging, stage.outside);

      for (const project of ["../x", climb]) {
        const error = yield* refusal(
          artifacts.publish({
            ...ask(stage, "climb.html", { name: "victim" }),
            project: Option.some(project),
          }),
          `publishing under project ${project}`
        );

        yield* expect(
          Predicate.isTagged(error, "ArtifactRefused") &&
            error.reason === "project",
          `project ${project} refused ${error._tag}${Predicate.isTagged(error, "ArtifactRefused") ? ` ${error.reason}` : ""}, expected ArtifactRefused project`
        );
      }

      yield* expect(
        (yield* fs.exists(planted)) &&
          (yield* fs.readFileString(planted)) === "keep\n",
        "the folder a climbing project names was removed or replaced"
      );
      yield* expect(
        !(yield* fs.exists(path.join(stage.data, "artifacts", "x"))),
        "a climbing project staged a copy outside the thread's staging folder"
      );
    })
  ),
];

/**
 * The broken control: a hand-written page published over straight through porch, as a Cairn
 * without its overwrite rule would. It fails when porch overwrote the page; a pass would mean
 * porch itself refused, and Cairn's rule is no longer what protects the user's pages.
 */
export const overwriteControl: ArtifactScenario<PorchClient> = scenario(
  "control: porch alone overwrites a hand-written page",
  (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const hand = "<p>control by hand</p>\n";
      yield* write(
        path.join(stage.artifacts, SCENARIO_PROJECT),
        "control.html",
        hand
      );
      const source = yield* write(stage.cwd, "control.html", "<p>agent</p>\n");

      yield* porch.publish(source, SCENARIO_PROJECT);

      yield* expect(
        (yield* readServed(stage, "control.html")) === hand,
        "porch overwrote the hand-written page"
      );
    })
);
