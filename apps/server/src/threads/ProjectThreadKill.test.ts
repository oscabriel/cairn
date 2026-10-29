// A refresh of the project thread under a real `kill -9` (the user's decision of 2026-10-29: each
// project has one project thread). Each case seeds a project and its first project thread in one
// process, then sends the refresh in another that kills itself with SIGKILL at a crash point
// (`fixtures/project-thread-kill.ts`); this process then opens the same `cairn.sqlite` as the next
// boot would, resumes the launches a restart cut off, and resends the refresh, as a client does:
//
// - killed after the launch row, before the shell commit: the old thread is still the one project
//   thread, and the resend completes the refresh;
// - killed inside the shell commit, after the new row was written: the same, since SQLite rolls the
//   commit back whole;
// - killed in the next commit, after the refresh landed: the new thread is the one project thread,
//   the boot resumes its launch, and the resend changes nothing.
//
// After every step exactly one live top-level thread is in the project, and it is the marked one.
// The broken control archives the old thread in a commit of its own and dies before making the new
// one; the check must find the project with none, which proves it can fail.

import { spawn } from "node:child_process";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option } from "effect";

import { ScriptedStore } from "../brain/ScriptedHarness.ts";
import { Projects } from "../projects/Projects.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import {
  FIRST,
  PROJECT_ID,
  REFRESH,
  SECOND,
} from "./fixtures/ProjectThreadLaunches.ts";
import { LaunchStore } from "./LaunchStore.ts";
import { ThreadLaunch } from "./ThreadLaunch.ts";
import {
  fileShell,
  HeldModel,
  ModelGate,
  threadsTestLayer,
} from "./ThreadsTestKit.ts";
import { TitleModel } from "./TitleModel.ts";

const fixture = path.join(
  import.meta.dirname,
  "fixtures",
  "project-thread-kill.ts"
);

/** How one fixture run ended: killed by its own SIGKILL, or done. */
const runFixture = (data: string, root: string, mode: string) =>
  Effect.callback<{ readonly killed: boolean; readonly done: boolean }>(
    (resume) => {
      const run = spawn(process.execPath, [fixture, data, root, mode], {
        stdio: ["ignore", "pipe", "inherit"],
      });

      let output = "";

      run.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf-8");
      });

      run.on("exit", (_code, signal) => {
        resume(
          Effect.succeed({
            killed: signal === "SIGKILL",
            done: output.includes('"event":"done"'),
          })
        );
      });

      return Effect.sync(() => {
        run.kill("SIGKILL");
      });
    }
  ).pipe(Effect.timeout(Duration.seconds(60)), Effect.orDie);

/** What the project holds: its mark and its live top-level threads. */
interface ProjectThreads {
  readonly mark: Option.Option<ThreadId>;
  readonly live: ReadonlyArray<ThreadId>;
}

const projectThreads = Effect.gen(function* () {
  const project = yield* (yield* Projects).get(PROJECT_ID);
  const rows = yield* (yield* ThreadRows).listByProject(PROJECT_ID);

  return {
    mark: Option.flatMap(project, (row) => row.shell.projectThreadId),
    live: rows
      .filter(
        (row) =>
          Option.isNone(row.shell.archivedAt) &&
          Option.isNone(row.shell.lineage)
      )
      .map((row) => row.shell.id),
  } satisfies ProjectThreads;
});

/** Exactly one project thread: one live top-level thread, and the project marks it. */
const exactlyOne = (held: ProjectThreads) =>
  held.live.length === 1 && Option.contains(held.mark, held.live[0] ?? "");

/** The next boot over the data folder the fixture left: the shell store and the launcher. */
const nextBoot = (data: string) =>
  threadsTestLayer({
    dataDir: data,
    titleModel: TitleModel.layerNone,
    model: HeldModel,
    shell: fileShell(path.join(data, "cairn.sqlite")),
  });

/** Resumes the launches a restart cut off and waits for them, as `BootRepairs` does at boot. */
const resumeLaunches = Effect.gen(function* () {
  yield* (yield* ModelGate).open;

  const launcher = yield* ThreadLaunch;

  yield* launcher.resumePending;

  for (const threadId of [FIRST, SECOND]) {
    yield* launcher.settled(threadId);
  }
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
  const data = path.join(dir, "data");
  const root = path.join(dir, "project");

  yield* fs.makeDirectory(data, { recursive: true });
  yield* fs.makeDirectory(root, { recursive: true });

  const seeded = yield* runFixture(data, root, "seed");

  assert.isTrue(seeded.done, "the seed ran to its end");

  return { data, root };
});

describe("kill -9 during a project thread refresh", () => {
  for (const point of [
    "before_create",
    "mid_commit",
    "after_commit",
  ] as const) {
    it.live(
      `killed ${point}: exactly one project thread after the boot and after the resend`,
      () =>
        Effect.gen(function* () {
          const { data, root } = yield* setup;
          const killed = yield* runFixture(data, root, point);

          assert.isTrue(killed.killed, "the fixture died by its own SIGKILL");
          assert.isFalse(killed.done);

          yield* Effect.gen(function* () {
            const landed = point === "after_commit";
            const afterKill = yield* projectThreads;

            assert.isTrue(exactlyOne(afterKill), JSON.stringify(afterKill));
            assert.deepStrictEqual(
              afterKill.mark,
              Option.some(landed ? SECOND : FIRST)
            );

            yield* resumeLaunches;

            const afterBoot = yield* projectThreads;

            assert.deepStrictEqual(afterBoot, afterKill);
            // The boot dropped a launch whose thread never landed, and finished one that did.
            assert.deepStrictEqual(yield* (yield* LaunchStore).listPending, []);
            assert.strictEqual(
              (yield* ScriptedStore).threads.has(SECOND),
              landed
            );

            const resent = yield* (yield* ThreadLaunch).launch(
              REFRESH,
              "owner@test"
            );

            yield* (yield* ThreadLaunch).settled(SECOND);

            assert.strictEqual(resent.resumed, landed);

            const afterResend = yield* projectThreads;

            assert.isTrue(exactlyOne(afterResend), JSON.stringify(afterResend));
            assert.deepStrictEqual(afterResend.mark, Option.some(SECOND));
            assert.isTrue((yield* ScriptedStore).threads.has(SECOND));

            const first = yield* (yield* ThreadRows).get(FIRST);

            assert.isTrue(
              Option.exists(first, (row) => Option.isSome(row.shell.archivedAt))
            );
          }).pipe(Effect.scoped, Effect.provide(nextBoot(data)));
        }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
      120_000
    );
  }

  it.live(
    "the broken control (archive, then create, in two commits) leaves a project the check finds without one",
    () =>
      Effect.gen(function* () {
        const { data, root } = yield* setup;
        const killed = yield* runFixture(data, root, "control");

        assert.isTrue(killed.killed);

        yield* Effect.gen(function* () {
          yield* resumeLaunches;

          const held = yield* projectThreads;

          assert.isFalse(exactlyOne(held));
          assert.deepStrictEqual(held.live, []);
        }).pipe(Effect.scoped, Effect.provide(nextBoot(data)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000
  );
});
