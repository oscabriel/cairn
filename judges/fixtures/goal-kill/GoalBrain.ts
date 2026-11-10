// The judge brain of `judges/goal-kill.ts`: a pi-durable Harness over a scratch SQLite store with
// the goals extension (`apps/server/src/verdicts`), pi-ai's faux provider as the goal thread's
// model, and the thread's commands run in a scratch folder. Each run of this script is one life of
// the brain: it opens the store, resumes what was running, does its step, waits for the judge runs
// to come to rest, prints its report as the last stdout line and exits. The orchestrator kills it
// with SIGKILL, or it kills itself at a planted window, and runs the next life over the same folder.
//
//   node judges/fixtures/goal-kill/GoalBrain.ts --dir <run> --step <step>
//     [--fault <point> --times N] [--control split]
//
// Steps:
// - `setup`: creates the goal thread with criterion c1, a command judge that appends a line to
//   `<run>/runs` (one line per time the judge's command ran), sleeps a second and exits 0.
// - `check`: the thread's model calls `goal_check` for c1.
// - `boot`: opens and waits; nothing else.
//
// `--fault <point>` (`queued` or `judged`, `JudgeFaultPoint`) kills the brain with SIGKILL there, at
// most `--times` times across lives (counted in `<run>/fault-count`). `--control split` is the
// broken control (`JudgeFaults.control`): the verdict is committed apart from the run's end, under a
// run id minted per attempt.
//
// The report counts what the judge asserts on: c1's state and tries, the verdict notes in the
// transcript, the judge runs indexed, the lines in `<run>/runs`, and whether every run settled.
// No network, no model spend.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Predicate, Result } from "effect";

import {
  callTool,
  createGoalThread,
  openGoalKit,
  readGoal,
  readRuns,
  send,
  verdictNotes,
  waitForJudges,
} from "../../../apps/server/src/verdicts/GoalTestKit.ts";
import type { JudgeFaultPoint } from "../../../apps/server/src/verdicts/JudgeRun.ts";

const context = BACKGROUND_CONTEXT;

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    step: { type: "string" },
    fault: { type: "string" },
    times: { type: "string", default: "1" },
    control: { type: "string", default: "none" },
  },
});

const dir = values.dir ?? "";

const step = values.step ?? "boot";

const model = { provider: "anthropic", modelId: "claude-faux" };

const runsFile = path.join(dir, "runs");

const countFile = path.join(dir, "fault-count");

const conversationFile = path.join(dir, "conversation");

/** Kills this life at `point` when the run asked for it, at most `--times` times across lives. */
const at = (point: JudgeFaultPoint) => {
  if (values.fault !== point) {
    return;
  }

  const count = existsSync(countFile)
    ? Number(readFileSync(countFile, "utf-8"))
    : 0;

  if (count >= Number(values.times)) {
    return;
  }

  writeFileSync(countFile, String(count + 1));
  process.kill(process.pid, "SIGKILL");
};

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "").length
    : 0;

const program = Effect.gen(function* () {
  const work = path.join(dir, "work");

  mkdirSync(work, { recursive: true });

  const kit = yield* Effect.acquireRelease(
    Effect.promise(
      async () =>
        await openGoalKit(
          {
            storage: await openNodeSqliteStorage(
              path.join(dir, "brain.sqlite")
            ),
            model,
            responses:
              step === "check"
                ? [callTool("goal_check", { criterion: "c1" }, "check-1")]
                : [],
            judges: {
              resolve: async () =>
                await Promise.resolve(Result.fail("No model judges here.")),
              ask: async () =>
                await Promise.resolve(Result.fail("No model judges here.")),
            },
            faults: {
              at,
              control: values.control === "split" ? "split" : "none",
            },
          },
          context
        )
    ),
    (open) =>
      Effect.promise(async () => {
        await open.close();
      })
  );

  if (step === "setup") {
    const created = yield* Effect.promise(
      async () =>
        await createGoalThread(
          kit,
          {
            threadId: "goal-kill",
            cwd: work,
            model,
            objective: "A judge run lands once",
            criteria: [
              {
                text: "The slow check passes",
                judge: {
                  kind: "command",
                  argv: ["sh", "-c", `echo run >> ${runsFile}; sleep 1`],
                  expectExit: 0,
                  timeoutSec: 60,
                },
              },
            ],
            now: 1,
          },
          context
        )
    );

    writeFileSync(conversationFile, String(created.id));
  }

  const conversation = yield* Effect.promise(
    async () =>
      await kit.harness.conversation(
        // SAFETY: the setup life wrote the conversation's id, a pi-durable ConversationId, here.
        // Verified by: judges/goal-kill.ts (every case reads its report through this id).
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- an id this brain wrote
        Number(readFileSync(conversationFile, "utf-8")) as ConversationId,
        context
      )
  ).pipe(
    Effect.filterOrElse(Predicate.isNotUndefined, () =>
      Effect.die("The goal thread is missing from the store.")
    )
  );

  if (step === "check") {
    yield* Effect.promise(async () => {
      await send(conversation, "Check c1.", "check", context);
    });
  }

  const settled =
    step === "setup"
      ? true
      : yield* Effect.promise(
          async () => await waitForJudges(kit, conversation, 20_000, context)
        );

  const goal = yield* Effect.promise(
    async () => await readGoal(kit, conversation, context)
  );

  const runs = yield* Effect.promise(
    async () => await readRuns(kit, conversation, context)
  );

  const notes = yield* Effect.promise(
    async () => await verdictNotes(conversation, context)
  );

  const criterion = goal?.criteria[0];

  yield* Console.log(
    JSON.stringify({
      event: "report",
      step,
      state: criterion?.state ?? null,
      tries: criterion?.tries ?? 0,
      runId: criterion?.verdict?.runId ?? null,
      notes: notes.length,
      queued: Object.keys(runs?.items ?? {}).length,
      ran: lines(runsFile),
      settled,
    })
  );
});

NodeRuntime.runMain(program.pipe(Effect.scoped));
