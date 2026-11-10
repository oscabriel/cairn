// One run of a command judge (`CommandRun.ts`): the command gets exactly the environment a
// thread's gated `bash` gets, the brain's without `CAIRN_*`, so a brief's `done_when` check and a
// goal's command judge never see Cairn's own settings. Over a real `NodeExecutionEnv`, built as the
// host arms build it (`brain/Arms.ts`).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Agent } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { threadProcessEnv } from "../brain/Arms.ts";
import { testLimit } from "../EventuallyTestKit.ts";
import { runCommand } from "./CommandRun.ts";
import type { CommandRunner } from "./CommandRun.ts";

const SECRET = "CAIRN_COMMAND_RUN_TEST_SECRET";

/** A task's view of a conversation in `cwd`, with the arms a host thread there gets. */
const runnerIn = (cwd: string): CommandRunner => ({
  // SAFETY: `runCommand` reads only the agent's `cwd`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  agent: async () => await Promise.resolve({ cwd } as Agent),
  env: async () =>
    await Promise.resolve(
      new NodeExecutionEnv({ cwd, shellEnv: threadProcessEnv(process.env) })
    ),
});

describe("a command judge's run", () => {
  it.live(
    "never shows the command the brain's CAIRN_ variables, as gated bash never does",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          process.env.CAIRN_COMMAND_RUN_TEST_SECRET = "leaked";

          return mkdtempSync(path.join(tmpdir(), "cairn-command-run-"));
        }),
        (cwd) =>
          Effect.gen(function* () {
            const ran = yield* Effect.promise(
              async () =>
                await runCommand(
                  runnerIn(cwd),
                  { argv: ["printenv", SECRET], timeoutSec: 10 },
                  BACKGROUND_CONTEXT
                )
            );

            assert.isTrue(Option.isSome(ran));

            const found = Option.getOrThrow(ran);

            assert.notInclude(found.tail, "leaked");
            // printenv exits 1 for a variable it cannot see.
            assert.strictEqual(found.exit, 1);
          }),
        (cwd) =>
          Effect.sync(() => {
            delete process.env.CAIRN_COMMAND_RUN_TEST_SECRET;
            rmSync(cwd, { recursive: true, force: true });
          })
      ),
    testLimit(30_000)
  );
});
