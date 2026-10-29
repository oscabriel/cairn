// Judges the `Cairn-Thread` commit trailer (docs/phase-2/notes/subagents.md section 6): a commit a
// thread's `bash` makes carries the thread's id, an existing `Cairn-Thread` line is replaced, the
// user's own process-level git config keeps its slots, and git older than 2.54 gets no hook. The
// first case runs a real `bash` call through pi-durable with a scripted model; the hook cases run
// git on a temporary repository with and without the hook's environment (the control: no hook, no
// trailer, which the same check must reject).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, RequestId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Stream,
} from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { Git, GIT_DEFAULTS } from "../git/Git.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { COMMIT_OPTIONS } from "../threads/ThreadsTestKit.ts";
import { BrainConfig } from "./BrainConfig.ts";
import {
  parseGitVersion,
  supportsTrailer,
  trailerCommand,
  withTrailerHook,
} from "./CommitTrailer.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const harness = PiDurableHarness.layer.pipe(
  Layer.provideMerge(
    ExtensionSet.layer.pipe(
      Layer.provide(ExecutorLink.layerDisabled),
      Layer.provide(PiHost.layerEmpty),
      Layer.provide(ModelHealth.layerTest),
      Layer.provide(SettingsStore.layerTest),
      Layer.provide(ReachServicesTest),
      Layer.provide(PiModelSource.layerFromModelSource)
    )
  ),
  Layer.provideMerge(
    ModelSource.layerFaux({
      tokensPerSecond: 4000,
      settings: { retry: { enabled: false } },
    })
  ),
  Layer.provide(
    BrainConfig.layerFrom(mkdtempSync(path.join(tmpdir(), "cairn-trailer-")))
  )
);

const Platform = Layer.mergeAll(Git.layer, NodeServices.layer);

const THREAD = ThreadId.make("0190f0c0-0000-7000-8000-000000000301");

const OTHER = ThreadId.make("0190f0c0-0000-7000-8000-000000000302");

/** The `Cairn-Thread` values of the commit at `ref`, as git parses its trailers. */
const trailersOf = (repo: string, ref: string) =>
  Git.use((git) =>
    git.stdout("test", repo, [
      "log",
      "-1",
      "--format=%(trailers:key=Cairn-Thread,valueonly)",
      ref,
    ])
  ).pipe(
    Effect.map((out) =>
      out
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
    )
  );

const makeRepo = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* Git;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const repo = path.join(dir, "repo");

  yield* git.stdout("test", dir, ["init", "--quiet", "-b", "main", repo]);

  return repo;
});

/** Commits in `repo` with `env`, the way a `bash` call's git would see it. */
const commitWith = (
  repo: string,
  env: Readonly<Record<string, string>>,
  message: string
) =>
  Git.use((git) =>
    git.stdoutWith(
      "test",
      repo,
      [...COMMIT_OPTIONS, "commit", "--quiet", "--allow-empty", "-m", message],
      { ...GIT_DEFAULTS, env }
    )
  );

describe("the commit trailer hook", () => {
  it("reads git's version and needs 2.54 or later", () => {
    assert.deepStrictEqual(
      parseGitVersion("git version 2.56.0\n"),
      Option.some({ major: 2, minor: 56 })
    );
    assert.isTrue(Option.isNone(parseGitVersion("bash: git: not found")));
    assert.isTrue(supportsTrailer({ major: 2, minor: 54 }));
    assert.isTrue(supportsTrailer({ major: 3, minor: 0 }));
    assert.isFalse(supportsTrailer({ major: 2, minor: 53 }));
  });

  it("numbers its pairs after the environment's own", () => {
    const env = withTrailerHook(
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Someone",
      },
      THREAD
    );

    assert.deepStrictEqual(env, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Someone",
      GIT_CONFIG_KEY_1: "hook.cairn-prepare-commit-msg.event",
      GIT_CONFIG_VALUE_1: "prepare-commit-msg",
      GIT_CONFIG_KEY_2: "hook.cairn-prepare-commit-msg.command",
      GIT_CONFIG_VALUE_2: trailerCommand(THREAD),
    });
  });

  it.live(
    "adds the trailer, replaces an old one, keeps the user's config, and a commit without the hook has none",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeRepo;

        yield* commitWith(repo, withTrailerHook({}, THREAD), "first");
        assert.deepStrictEqual(yield* trailersOf(repo, "HEAD"), [THREAD]);

        yield* commitWith(
          repo,
          withTrailerHook({}, THREAD),
          `second\n\nCairn-Thread: ${OTHER}`
        );
        assert.deepStrictEqual(yield* trailersOf(repo, "HEAD"), [THREAD]);

        yield* commitWith(
          repo,
          withTrailerHook(
            {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "user.name",
              GIT_CONFIG_VALUE_0: "Configured Name",
            },
            OTHER
          ),
          "third"
        );
        assert.deepStrictEqual(yield* trailersOf(repo, "HEAD"), [OTHER]);
        assert.strictEqual(
          (yield* Git.use((git) =>
            git.stdout("test", repo, ["log", "-1", "--format=%an"])
          )).trim(),
          // `-c user.name` in COMMIT_OPTIONS outranks the environment's pair, which git still
          // parsed: a bad numbering would have failed the commit instead.
          "Cairn Test"
        );

        // The control: no hook in the environment, no trailer.
        yield* commitWith(repo, {}, "fourth");
        assert.deepStrictEqual(yield* trailersOf(repo, "HEAD"), []);
      }).pipe(Effect.scoped, Effect.provide(Platform))
  );
});

describe("a thread's bash", () => {
  it.live(
    "commits with Cairn-Thread naming the thread",
    () =>
      Effect.gen(function* () {
        const repo = yield* makeRepo;
        const seam = yield* HarnessSeam;
        const { faux } = yield* FauxModels;

        faux.setResponses([
          fauxAssistantMessage(
            [
              fauxToolCall("bash", {
                command: `git ${COMMIT_OPTIONS.map((option) => `'${option}'`).join(" ")} commit --quiet --allow-empty -m "child work"`,
              }),
            ],
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("done"),
        ]);

        yield* seam.ensureThread({
          threadId: THREAD,
          projectId: ProjectId.make("trailer"),
          model: FAUX_MODEL,
          thinkingLevel: "off",
          cwd: repo,
          instructions: Option.none(),
          runtimeMode: "full-access",
        });

        const ended = yield* seam.events.pipe(
          Stream.filter(
            (event) =>
              Predicate.isTagged(event, "RunTerminal") &&
              event.threadId === THREAD
          ),
          Stream.runHead,
          Effect.forkChild
        );

        yield* Effect.sleep("20 millis");
        yield* seam.submit(THREAD, {
          requestId: RequestId.make("trailer-1"),
          content: [{ type: "text", text: "commit" }],
          entry: Option.none(),
          whenBusy: "followUp",
        });
        yield* Fiber.join(ended);

        assert.deepStrictEqual(yield* trailersOf(repo, "HEAD"), [THREAD]);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(harness, Platform))),
    30_000
  );
});
