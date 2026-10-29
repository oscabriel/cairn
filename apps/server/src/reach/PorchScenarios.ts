// The porch contract as scenarios, run on two stages: `PorchClient.test.ts` runs them on the fake
// layer, and `judges/porch-contract.ts` on the real binary against a throwaway Caddy. Both stages
// passing is what makes the fake faithful: every receipt and refusal a later package's tests rely
// on was also seen from porch itself.
//
// The publisher scenarios hold Cairn's own rule (porch overwrites a file it did not publish, so
// `ArtifactPublisher` refuses from the `artifacts` table). `unmanagedControl` is their broken
// control: it publishes the same file straight through porch, as a publisher without the rule
// would, and the judge expects it to fail the "hand-written file intact" check.

import { createHash } from "node:crypto";
import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import { Effect, FileSystem, Option, Predicate, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ArtifactPublisher, artifactIdOf } from "./ArtifactPublisher.ts";
import { PorchClient } from "./PorchClient.ts";

/** Where one stage's porch lives and how to break its proxy. */
export interface PorchStage {
  readonly domain: string;
  /** porch's artifacts folder. */
  readonly artifacts: string;
  /** An empty folder the scenarios write their sources into. */
  readonly sources: string;
  /** Every reload from now on is refused by the proxy. */
  readonly breakProxy: Effect.Effect<void>;
  /** Reloads succeed again. */
  readonly mendProxy: Effect.Effect<void>;
  /** Words the broken proxy's refusal contains, which porch must pass on. */
  readonly brokenProxyText: string;
}

/** A scenario's check did not hold. */
export class ScenarioFailure extends Schema.TaggedError<ScenarioFailure>()(
  "ScenarioFailure",
  { message: Schema.String }
) {}

/** Fails the scenario with `message` unless `condition` holds. */
const expect = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ScenarioFailure({ message }));

/** Runs `effect` and answers its failure, failing the scenario if it succeeded. */
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>, what: string) =>
  effect.pipe(
    Effect.flip,
    Effect.mapError(
      () =>
        new ScenarioFailure({
          message: `${what} succeeded; it should be refused`,
        })
    )
  );

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const PROJECT = "judge";

const THREAD_A = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000a001");

const THREAD_B = ThreadId.make("0199f0c2-6a4e-7d4c-8a6b-00000000b002");

/** One check of the contract; any unexpected failure becomes a `ScenarioFailure` naming it. */
export interface PorchScenario<R> {
  readonly name: string;
  run(
    stage: PorchStage
  ): Effect.Effect<void, ScenarioFailure, R | FileSystem.FileSystem>;
}

const scenario = <R, E extends { readonly message: string }>(
  name: string,
  body: (stage: PorchStage) => Effect.Effect<void, E, R | FileSystem.FileSystem>
): PorchScenario<R> => ({
  name,
  run: (stage) =>
    body(stage).pipe(
      Effect.mapError((failure) =>
        Predicate.isTagged(failure, "ScenarioFailure")
          ? new ScenarioFailure({ message: failure.message })
          : new ScenarioFailure({
              message: `unexpected failure: ${failure.message}`,
            })
      )
    ),
});

const writeSource = (stage: PorchStage, relative: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = path.join(stage.sources, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);

    return file;
  });

const readTarget = (stage: PorchStage, relative: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return yield* fs.readFileString(path.join(stage.artifacts, relative));
  });

/** The porch client's own contract: receipts, refusals and the proxy's words. */
export const clientScenarios: ReadonlyArray<PorchScenario<PorchClient>> = [
  scenario("version and machine config", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const version = yield* porch.version;
      yield* expect(version.length > 0, "porch --version printed nothing");
      const machine = yield* porch.machine;
      yield* expect(
        machine.domain === stage.domain,
        `machine domain ${machine.domain}, expected ${stage.domain}`
      );
      yield* expect(
        machine.artifacts === stage.artifacts,
        `machine artifacts ${machine.artifacts}, expected ${stage.artifacts}`
      );
    })
  ),
  scenario("publish, republish, edit", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const first = "<p>first</p>\n";
      const source = yield* writeSource(stage, "a/report.html", first);
      const url = `https://plans.${stage.domain}/${PROJECT}/report.html`;

      const published = yield* porch.publish(source, PROJECT);
      yield* expect(published.changed, "a first publish is changed");
      yield* expect(
        published.url === url,
        `url ${published.url}, expected ${url}`
      );
      yield* expect(
        published.hash === sha256(first),
        "a file's hash is the sha256 of its bytes"
      );
      yield* expect(
        (yield* readTarget(stage, `${PROJECT}/report.html`)) === first,
        "the copy holds the source's bytes"
      );

      const again = yield* porch.publish(source, PROJECT);
      yield* expect(!again.changed, "the same bytes again are changed: false");
      yield* expect(
        again.url === url && again.hash === published.hash,
        "a republish keeps the url and hash"
      );

      const second = "<p>second</p>\n";
      yield* writeSource(stage, "a/report.html", second);
      const edited = yield* porch.publish(source, PROJECT);
      yield* expect(edited.changed, "an edit is changed");
      yield* expect(edited.url === url, "an edit keeps the url");
      yield* expect(edited.hash === sha256(second), "an edit has the new hash");
    })
  ),
  scenario("publish from another source is refused exists", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const mine = yield* writeSource(stage, "b1/same.html", "<p>mine</p>\n");

      const theirs = yield* writeSource(
        stage,
        "b2/same.html",
        "<p>theirs</p>\n"
      );

      yield* porch.publish(mine, PROJECT);

      const error = yield* refusal(
        porch.publish(theirs, PROJECT),
        "a second source"
      );

      yield* expect(
        error.reason === "exists" &&
          Option.getOrNull(error.porchCode) === "exists",
        `refused ${error.reason}, expected exists`
      );
      yield* expect(
        (yield* readTarget(stage, `${PROJECT}/same.html`)) === "<p>mine</p>\n",
        "a refused publish leaves the copy alone"
      );
    })
  ),
  scenario("folders: index.html required, url ends with a slash", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;

      const index = yield* writeSource(
        stage,
        "c/site/index.html",
        "<p>site</p>\n"
      );

      const published = yield* porch.publish(path.dirname(index), PROJECT);
      yield* expect(
        published.url === `https://plans.${stage.domain}/${PROJECT}/site/`,
        `folder url ${published.url}`
      );
      yield* expect(
        (yield* readTarget(stage, `${PROJECT}/site/index.html`)) ===
          "<p>site</p>\n",
        "the folder's index was copied"
      );

      const bare = yield* writeSource(stage, "c/bare/notes.txt", "x\n");

      const noIndex = yield* refusal(
        porch.publish(path.dirname(bare), PROJECT),
        "a folder with no index.html"
      );

      yield* expect(
        noIndex.reason === "missing",
        `refused ${noIndex.reason}, expected missing`
      );

      const gone = yield* refusal(
        porch.publish(path.join(stage.sources, "c", "none.html"), PROJECT),
        "a missing source"
      );

      yield* expect(
        gone.reason === "missing",
        `refused ${gone.reason}, expected missing`
      );
    })
  ),
  scenario("inputs Cairn refuses before porch runs", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;

      const relative = yield* refusal(
        porch.publish("report.html", PROJECT),
        "a relative source"
      );

      yield* expect(
        relative.reason === "bad-input",
        "a relative source is bad-input"
      );
      const source = yield* writeSource(stage, "d/x.html", "x\n");

      const climb = yield* refusal(
        porch.publish(source, "../up"),
        "a climbing project"
      );

      yield* expect(
        climb.reason === "bad-input",
        "a climbing project is bad-input"
      );

      const flag = yield* refusal(
        porch.add("--replace", "http://127.0.0.1:3101"),
        "a flag as a name"
      );

      yield* expect(
        flag.reason === "bad-input",
        "a flag as a name is bad-input"
      );

      const remote = yield* refusal(
        porch.add("judge-remote", "http://10.0.0.1:80"),
        "a remote upstream"
      );

      yield* expect(
        remote.reason === "bad-input",
        "a remote upstream is bad-input"
      );
    })
  ),
  scenario("service porches: add, list, refusals, remove", (stage) =>
    Effect.gen(function* () {
      const porch = yield* PorchClient;
      const added = yield* porch.add("main--judge", "http://127.0.0.1:3101");
      yield* expect(
        added.url === `https://main--judge.${stage.domain}` &&
          added.name === "main--judge",
        `add url ${added.url}`
      );
      yield* expect(added.reloaded, "add reloads the proxy");

      const rows = yield* porch.list;
      yield* expect(
        rows.some(
          (row) => row.name === "main--judge" && row.kind === "service"
        ),
        "ls lists the service porch"
      );
      yield* expect(
        rows.some((row) => row.name === "plans" && row.kind === "artifacts"),
        "ls lists the artifacts porch a publish created"
      );

      const twice = yield* refusal(
        porch.add("main--judge", "http://127.0.0.1:3102"),
        "a second add"
      );

      yield* expect(
        twice.reason === "exists",
        `refused ${twice.reason}, expected exists`
      );

      const reserved = yield* refusal(
        porch.add("plans", "http://127.0.0.1:3102"),
        "a reserved name"
      );

      yield* expect(
        reserved.reason === "reserved",
        `refused ${reserved.reason}, expected reserved`
      );

      const removed = yield* porch.remove("main--judge");
      yield* expect(
        removed.removed === "main--judge" && removed.reloaded,
        "rm removes and reloads"
      );
      const again = yield* refusal(porch.remove("main--judge"), "a second rm");
      yield* expect(
        again.reason === "missing",
        `refused ${again.reason}, expected missing`
      );
    })
  ),
  scenario(
    "a refused reload is proxy-refused with the proxy's words, and changes nothing",
    (stage) =>
      Effect.gen(function* () {
        const porch = yield* PorchClient;
        yield* stage.breakProxy;

        const refused = yield* refusal(
          porch.add("refused--judge", "http://127.0.0.1:3103"),
          "an add the proxy refuses"
        ).pipe(Effect.ensuring(stage.mendProxy));

        yield* expect(
          refused.reason === "proxy-refused",
          `refused ${refused.reason}, expected proxy-refused`
        );
        yield* expect(
          refused.detail.includes(stage.brokenProxyText),
          `the refusal does not carry the proxy's words: ${refused.detail}`
        );
        const rows = yield* porch.list;
        yield* expect(
          !rows.some((row) => row.name === "refused--judge"),
          "a refused add is not in the registry"
        );
        const applied = yield* porch.apply;
        yield* expect(
          applied.reloaded,
          "apply reloads once the proxy is mended"
        );
      })
  ),
];

/** Cairn's own publish rule over porch, through `ArtifactPublisher` and the `artifacts` table. */
export const publisherScenarios: ReadonlyArray<
  PorchScenario<PorchClient | ArtifactPublisher | SqlClient.SqlClient>
> = [
  scenario("Cairn refuses to overwrite a file it did not publish", (stage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const publisher = yield* ArtifactPublisher;
      const hand = path.join(stage.artifacts, PROJECT, "hand.html");
      yield* fs.makeDirectory(path.dirname(hand), { recursive: true });
      yield* fs.writeFileString(hand, "<p>written by hand</p>\n");

      const source = yield* writeSource(
        stage,
        "p1/hand.html",
        "<p>agent</p>\n"
      );

      const error = yield* refusal(
        publisher.publish({ threadId: THREAD_A, source, project: PROJECT }),
        "publishing over a hand-written file"
      );

      yield* expect(
        Predicate.isTagged(error, "ArtifactPublishError") &&
          error.reason === "unmanaged",
        `refused ${error._tag}, expected ArtifactPublishError unmanaged`
      );
      yield* expect(
        (yield* fs.readFileString(hand)) === "<p>written by hand</p>\n",
        "the hand-written file is intact"
      );
    })
  ),
  scenario(
    "a thread republishes its own page in place; another thread is refused",
    (stage) =>
      Effect.gen(function* () {
        const publisher = yield* ArtifactPublisher;

        const source = yield* writeSource(
          stage,
          "p2/mine.html",
          "<p>one</p>\n"
        );

        const first = yield* publisher.publish({
          threadId: THREAD_A,
          source,
          project: PROJECT,
        });

        yield* expect(first.changed, "a first publish is changed");
        yield* expect(
          first.row.id === artifactIdOf(PROJECT, "mine.html") &&
            first.row.kind === "file" &&
            first.row.bytes === "<p>one</p>\n".length,
          "the row names the page, its kind and size"
        );

        const again = yield* publisher.publish({
          threadId: THREAD_A,
          source,
          project: PROJECT,
        });

        yield* expect(!again.changed, "the same bytes are changed: false");
        yield* expect(
          again.row.url === first.row.url,
          "a republish keeps the url"
        );

        const other = yield* writeSource(
          stage,
          "p2b/mine.html",
          "<p>other</p>\n"
        );

        const taken = yield* refusal(
          publisher.publish({
            threadId: THREAD_B,
            source: other,
            project: PROJECT,
          }),
          "another thread's publish of the same name"
        );

        yield* expect(
          Predicate.isTagged(taken, "ArtifactPublishError") &&
            taken.reason === "taken",
          `refused ${taken._tag}, expected taken`
        );
      })
  ),
  scenario(
    "a crash between porch and the row leaves the key Cairn's",
    (stage) =>
      Effect.gen(function* () {
        const porch = yield* PorchClient;
        const publisher = yield* ArtifactPublisher;
        const sql = yield* SqlClient.SqlClient;

        const source = yield* writeSource(
          stage,
          "p3/crash.html",
          "<p>crash</p>\n"
        );

        // The claim committed and porch published, then the brain died before the row update.
        yield* sql`
          INSERT INTO artifacts (id, thread_id, project_slug, name, claimed_at, updated_at)
          VALUES (${artifactIdOf(PROJECT, "crash.html")}, ${THREAD_A}, ${PROJECT}, ${"crash.html"}, 1, 1)
        `;
        yield* porch.publish(source, PROJECT);

        const rerun = yield* publisher.publish({
          threadId: THREAD_A,
          source,
          project: PROJECT,
        });

        yield* expect(!rerun.changed, "the rerun finds porch's copy unchanged");
        yield* expect(
          rerun.row.hash === sha256("<p>crash</p>\n"),
          "the rerun records the hash"
        );
      })
  ),
  scenario(
    "a crash after the claim and before porch leaves a claim its thread publishes",
    (stage) =>
      Effect.gen(function* () {
        const publisher = yield* ArtifactPublisher;
        const sql = yield* SqlClient.SqlClient;

        const source = yield* writeSource(
          stage,
          "p5/claimed.html",
          "<p>claimed</p>\n"
        );

        // The claim committed, then the brain died before porch ran.
        yield* sql`
          INSERT INTO artifacts (id, thread_id, project_slug, name, claimed_at, updated_at)
          VALUES (${artifactIdOf(PROJECT, "claimed.html")}, ${THREAD_A}, ${PROJECT}, ${"claimed.html"}, 1, 1)
        `;

        const other = yield* refusal(
          publisher.publish({
            threadId: THREAD_B,
            source,
            project: PROJECT,
          }),
          "another thread's publish over a dangling claim"
        );

        yield* expect(
          Predicate.isTagged(other, "ArtifactPublishError") &&
            other.reason === "taken",
          `refused ${other._tag}, expected taken`
        );

        const rerun = yield* publisher.publish({
          threadId: THREAD_A,
          source,
          project: PROJECT,
        });

        yield* expect(rerun.changed, "the rerun publishes the page");
        yield* expect(
          (yield* readTarget(stage, `${PROJECT}/claimed.html`)) ===
            "<p>claimed</p>\n",
          "the page is on disk"
        );
      })
  ),
  scenario("a climbing project is refused before any path or row", (stage) =>
    Effect.gen(function* () {
      const publisher = yield* ArtifactPublisher;
      const sql = yield* SqlClient.SqlClient;

      const source = yield* writeSource(
        stage,
        "p6/climb.html",
        "<p>climb</p>\n"
      );

      const error = yield* refusal(
        publisher.publish({ threadId: THREAD_A, source, project: ".." }),
        "a publish to project .."
      );

      yield* expect(
        Predicate.isTagged(error, "PorchError") && error.reason === "bad-input",
        `refused ${error._tag}, expected PorchError bad-input`
      );

      const rows =
        yield* sql`SELECT id FROM artifacts WHERE name = ${"climb.html"}`;

      yield* expect(rows.length === 0, "no claim was written");
    })
  ),
  scenario("a fresh claim porch refuses gives the key back", (stage) =>
    Effect.gen(function* () {
      const publisher = yield* ArtifactPublisher;
      const sql = yield* SqlClient.SqlClient;
      const bare = yield* writeSource(stage, "p4/empty/notes.txt", "x\n");

      const error = yield* refusal(
        publisher.publish({
          threadId: THREAD_A,
          source: path.dirname(bare),
          project: PROJECT,
        }),
        "a folder with no index.html"
      );

      yield* expect(
        Predicate.isTagged(error, "PorchError") && error.reason === "missing",
        `refused ${error._tag}, expected PorchError missing`
      );
      const rows = yield* sql`SELECT id FROM artifacts WHERE name = ${"empty"}`;
      yield* expect(rows.length === 0, "the refused claim was released");
    })
  ),
];

/**
 * The broken control for "Cairn refuses to overwrite a file it did not publish": the same publish
 * straight through porch. It fails its check while porch still overwrites unmanaged files.
 */
export const unmanagedControl: PorchScenario<PorchClient> = scenario(
  "control: porch alone overwrites a hand-written file",
  (stage) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const porch = yield* PorchClient;
      const hand = path.join(stage.artifacts, PROJECT, "control.html");
      yield* fs.makeDirectory(path.dirname(hand), { recursive: true });
      yield* fs.writeFileString(hand, "<p>written by hand</p>\n");

      const source = yield* writeSource(
        stage,
        "ctl/control.html",
        "<p>agent</p>\n"
      );

      yield* porch.publish(source, PROJECT).pipe(Effect.ignore);
      yield* expect(
        (yield* fs.readFileString(hand)) === "<p>written by hand</p>\n",
        "the hand-written file is intact"
      );
    })
);
