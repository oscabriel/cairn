// The seam an orchestration task's phase runs through (`failsVisibly`, review finding O-3), over a
// real pi-durable Harness: a phase that throws ends in its recovery's commit, never `faulted`; a
// recovery that sleeps (the workflow stopper's) runs the phase again later; and an aborted phase
// rethrows, so its abort handler ends it and the recovery never runs. The subagent tasks' own
// recoveries are judged in `brain/SubagentTaskFailures.test.ts`.

import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTask,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import type { TaskId } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { failsVisibly } from "./TaskFailures.ts";

const context = BACKGROUND_CONTEXT;

const PLANTED = "planted: the phase broke";

/** How many times each kind of task's phase ran, and its recovery. */
const counts = { thrown: 0, recovered: 0, slept: 0 };

interface Work {
  phase: "work";
}

/** Throws on every run; its recovery completes with why. */
const Recorded = defineTask<null, Work, string>({
  name: "test.recorded",
  version: 1,
  initial: () => ({ phase: "work" }),
  phases: {
    work: failsVisibly<null, Work, string, object>(async (_tx, failed) => {
      counts.recovered += 1;

      return await Promise.resolve({
        status: "terminal" as const,
        outcome: { status: "completed" as const, result: failed.why },
      });
    })(async () => {
      counts.thrown += 1;

      await Promise.reject(new Error(PLANTED));
    }),
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      ctx
    );
  },
});

/** Throws on its first run; its recovery sleeps, and the second run completes. */
const Retried = defineTask<null, Work, string>({
  name: "test.retried",
  version: 1,
  initial: () => ({ phase: "work" }),
  phases: {
    work: failsVisibly<null, Work, string, object>(async (_tx, failed) => {
      counts.slept += 1;

      return await Promise.resolve({
        status: "sleeping" as const,
        until: failed.at + 50,
        checkpoint: { phase: "work" as const },
      });
    })(async (_task, runtime, ctx) => {
      if (counts.slept === 0) {
        throw new Error(PLANTED);
      }

      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: "ran again" },
        }),
        ctx
      );
    }),
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      ctx
    );
  },
});

/** Waits for its abort, then throws: the abort is the abort handler's. */
const Aborted = defineTask<null, Work, string>({
  name: "test.aborted",
  version: 1,
  initial: () => ({ phase: "work" }),
  phases: {
    work: failsVisibly<null, Work, string, object>(async () => {
      counts.recovered += 1;

      return await Promise.resolve({
        status: "terminal" as const,
        outcome: { status: "completed" as const, result: "recovered" },
      });
    })(async (_task, runtime) => {
      await sleep(60_000, null, { signal: runtime.signal }).catch(() => null);

      runtime.signal.throwIfAborted();
    }),
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      ctx
    );
  },
});

/** A resumed Harness with the three tasks, closed with the scope. */
const harnessScoped = Effect.acquireRelease(
  Effect.promise(async () => {
    const registry = createRegistry();

    registry.install(
      defineExtension({
        name: "test.failures",
        tasks: [Recorded, Retried, Aborted],
      })
    );

    const harness = await Harness.open(
      new MemoryStorage(),
      { models: createModels(), registry },
      context
    );

    harness.resume();

    return harness;
  }),
  (harness) =>
    Effect.promise(async () => {
      await harness.close(context);
    })
);

/** Creates `task` in a fresh conversation. */
const started = (harness: Harness, task: typeof Recorded) =>
  Effect.promise(async () => {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context
    );

    return await harness.commit(
      async (tx): Promise<TaskId<string>> =>
        await tx.createTask(task, null, {
          ownership: { kind: "conversation" },
          conversationId: conversation.id,
          background: true,
        }),
      context
    );
  });

describe("an orchestration task's phase that throws (O-3)", () => {
  it.live("ends in its recovery's commit, completed and not faulted", () =>
    Effect.gen(function* () {
      counts.thrown = 0;
      counts.recovered = 0;

      const harness = yield* harnessScoped;
      const id = yield* started(harness, Recorded);

      const settled = yield* Effect.promise(
        async () => await harness.waitForTask(id, context)
      );

      assert.deepStrictEqual(settled.state.outcome, {
        status: "completed",
        result: PLANTED,
      });
      assert.deepStrictEqual([counts.thrown, counts.recovered], [1, 1]);
    }).pipe(Effect.scoped)
  );

  it.live("a recovery that sleeps runs the phase again", () =>
    Effect.gen(function* () {
      counts.slept = 0;

      const harness = yield* harnessScoped;
      const id = yield* started(harness, Retried);

      const settled = yield* Effect.promise(
        async () => await harness.waitForTask(id, context)
      );

      assert.deepStrictEqual(settled.state.outcome, {
        status: "completed",
        result: "ran again",
      });
      assert.strictEqual(counts.slept, 1);
    }).pipe(Effect.scoped)
  );

  it.live("an aborted phase rethrows to its abort handler", () =>
    Effect.gen(function* () {
      counts.recovered = 0;

      const harness = yield* harnessScoped;
      const id = yield* started(harness, Aborted);

      yield* Effect.sleep("100 millis");
      yield* Effect.promise(async () => await harness.abortTask(id, context));

      const settled = yield* Effect.promise(
        async () => await harness.waitForTask(id, context)
      );

      assert.strictEqual(settled.state.outcome.status, "aborted");
      assert.strictEqual(counts.recovered, 0);
    }).pipe(Effect.scoped)
  );
});
