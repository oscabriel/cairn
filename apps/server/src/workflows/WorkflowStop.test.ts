// Stopping a workflow or one node (ADR 0012 as amended, workflows note W6), on a real pi-durable
// Harness with the code mode, workflows and results extensions over the kit's faux model
// (WorkflowTestKit.ts): the stopped node is null to the script and keeps a receipt of its spend, a
// whole-workflow stop ends the row `stopped` with nothing more dispatched, an approved workflow
// stopped before its script runs never runs, and a node held in a wait deaf to its signal stops at
// once because the node tools poll it (the deaf control waits the hold out). The kill matrix is
// `judges/workflow-stop.ts`.

import { ThreadId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate, Result } from "effect";

import { ThreadReceipt } from "../brain/CairnDocs.ts";
import {
  isWorkflowEnded,
  settledTokens,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type {
  NodeItemState,
  WorkflowItemState,
  WorkflowsState,
} from "./WorkflowDocs.ts";
import {
  stopNodeIn,
  stopWorkflowIn,
  untilStopped,
  WorkflowStops,
} from "./WorkflowStop.ts";
import type { StopOutcome } from "./WorkflowStop.ts";
import {
  codemodeResultText,
  kitParts,
  KitLayer,
  openKit,
  pause,
  plant,
  plantDefaults,
  runScript,
} from "./WorkflowTestKit.ts";
import type { KitBrain, WorkEffect } from "./WorkflowTestKit.ts";
import { NO_WORKFLOW_FAULTS } from "./WorkflowTools.ts";
import type { HoldPoint, WorkflowFaultSet } from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

const WF = "wf-1";

const THREAD = ThreadId.make("01900000-0000-7000-8000-000000000001");

const workflow = (body: string) =>
  `export const meta = {\n  name: "stop-kit",\n  description: "A kit workflow to stop",\n  phases: [{ title: "Fan" }],\n};\n${body}`;

/** Three nodes at once, b the longest, then d. */
const FAN = workflow(`phase("Fan");
const [a, b, c] = await parallel([
  () => agent("node:a ms=300", { label: "a" }),
  () => agent("node:b ms=6000", { label: "b" }),
  () => agent("node:c ms=300", { label: "c" }),
]);
const d = await agent("node:d ms=100", { label: "d" });
const spent = await budget.spent();
return { a, b, c, d, spent };`);

/** One brain over memory storage, with the launch of `source` planted on its root thread. */
const kit = (
  source: string,
  options: {
    readonly faults?: WorkflowFaultSet;
    readonly hold?: {
      readonly point: HoldPoint;
      readonly label: string;
      readonly ms: number;
    };
    readonly plant?: boolean;
  } = {}
) =>
  Effect.gen(function* () {
    const effects: Array<WorkEffect> = [];

    const parts = yield* kitParts({
      faults: options.faults ?? NO_WORKFLOW_FAULTS,
      hold: async (point, label) => {
        if (point === options.hold?.point && label === options.hold.label) {
          await pause(options.hold.ms);
        }
      },
      effect: (line) => {
        effects.push(line);
      },
      tokensPerSecond: 50_000,
    });

    const brain = yield* Effect.acquireRelease(
      Effect.promise(
        async () => await openKit(new MemoryStorage(), parts, context)
      ),
      (open) =>
        Effect.promise(async () => {
          await open.harness.close(context);
        })
    );

    if (options.plant ?? true) {
      yield* plant(brain, source, plantDefaults(WF), context);
    }

    yield* Effect.promise(async () => {
      await brain.harness.commit(async (tx) => {
        const receipt = await tx.doc(ThreadReceipt, THREAD, {
          conversationId: 0,
        });

        receipt.conversationId = brain.root;
      }, context);
    });

    return { brain, effects };
  });

const ledgerOf = async (brain: KitBrain): Promise<Readonly<WorkflowsState>> =>
  (await brain.harness.snapshot(WorkflowsDoc, brain.root, context)) ?? {
    items: {},
  };

/** The workflow's row, if planted. */
const rowOf = async (
  brain: KitBrain
): Promise<WorkflowItemState | undefined> => {
  const ledger = await ledgerOf(brain);

  return ledger.items[WF];
};

/** Waits until `found` answers something for the ledger, at most `ms`. */
const waitFor = async <A>(
  brain: KitBrain,
  found: (row: Readonly<WorkflowItemState> | undefined) => A | undefined,
  ms = 10_000
): Promise<A> => {
  const until = performance.now() + ms;

  while (performance.now() < until) {
    // oxlint-disable-next-line no-await-in-loop
    const value = found(await rowOf(brain));

    if (value !== undefined) {
      return value;
    }

    // oxlint-disable-next-line no-await-in-loop
    await pause(20);
  }

  throw new Error("timed out waiting on the ledger");
};

const nodeNamed = (
  row: Readonly<WorkflowItemState> | undefined,
  label: string
): NodeItemState | undefined =>
  Object.values(row?.nodes ?? {}).find((node) => node.label === label);

/** Waits until node `label` runs, and answers its row. */
const running = async (brain: KitBrain, label: string) =>
  await waitFor(brain, (row) => {
    const node = nodeNamed(row, label);

    return node?.state === "running" ? node : undefined;
  });

/** Waits until the workflow ended and the thread is idle, and answers its row. */
const ended = async (brain: KitBrain): Promise<WorkflowItemState> => {
  await brain.harness.waitForIdle(context);

  return await waitFor(brain, (row) =>
    row !== undefined && isWorkflowEnded(row.state) ? row : undefined
  );
};

const starts = (effects: ReadonlyArray<WorkEffect>, what: WorkEffect["what"]) =>
  effects.flatMap((line) => (line.what === what ? [line.node] : [])).toSorted();

const kindOf = (outcome: StopOutcome) => outcome.kind;

/** A stop's signal, made outside Effect code: a node tool's `context.abortSignal` stands in here. */
const stopper = () => new AbortController();

/** How `untilStopped` ended: `settled`, or the message it rejected with. */
const endingOf = (signal: AbortSignal, work: Promise<number>) =>
  Effect.tryPromise({
    try: async () => await untilStopped(signal, work),
    catch: (cause) => (cause instanceof Error ? cause.message : "rejected"),
  }).pipe(
    Effect.match({
      onFailure: (message) => message,
      onSuccess: (value) => `settled ${String(value)}`,
    })
  );

describe("a node tool's wait at a stop", () => {
  it.live("settles as the work does while nothing stops it", () =>
    Effect.gen(function* () {
      const controller = stopper();

      assert.strictEqual(
        yield* endingOf(controller.signal, Promise.resolve(7)),
        "settled 7"
      );
    })
  );

  it.live("passes the work's own rejection on", () =>
    Effect.gen(function* () {
      const controller = stopper();

      assert.strictEqual(
        yield* endingOf(controller.signal, Promise.reject(new Error("own"))),
        "own"
      );
    })
  );

  it.live("rejects at the stop, without waiting for deaf work", () =>
    Effect.gen(function* () {
      const controller = stopper();
      const started = performance.now();

      setTimeout(() => {
        controller.abort(new Error("stopped"));
      }, 50);

      const ending = yield* endingOf(
        controller.signal,
        pause(5000).then(() => 1)
      );

      assert.strictEqual(ending, "stopped");
      assert.isBelow(performance.now() - started, 1000);
    })
  );

  it.live("rejects at once when already stopped", () =>
    Effect.gen(function* () {
      const controller = stopper();

      controller.abort(new Error("before"));

      assert.strictEqual(
        yield* endingOf(controller.signal, Promise.resolve(1)),
        "before"
      );
    })
  );
});

describe("workflow stop on pi-durable", () => {
  it.live(
    "stops one node: null to the script, the rest run, its spend still counts",
    () =>
      Effect.gen(function* () {
        const { brain, effects } = yield* kit(FAN);

        const outcome = yield* Effect.promise(async () => {
          await runScript(brain, FAN, "run-1", context);

          const b = await running(brain, "b");

          await pause(300);

          const stopped = await stopNodeIn(
            brain.harness,
            brain.root,
            WF,
            b.id,
            context
          );

          return {
            stopped,
            again: await stopNodeIn(
              brain.harness,
              brain.root,
              WF,
              b.id,
              context
            ),
            row: await ended(brain),
            result: await codemodeResultText(brain, context),
          };
        });

        assert.strictEqual(kindOf(outcome.stopped), "aborted");
        // A second stop is harmless: the row has ended, or its task carries the mark already.
        assert.include(["ended", "aborted"], outcome.again.kind);

        const { row, result } = outcome;
        const b = nodeNamed(row, "b");

        assert.strictEqual(row.state, "finished");
        assert.strictEqual(b?.state, "stopped");
        assert.include(result, '"b":null');

        for (const label of ["a", "c", "d"]) {
          assert.strictEqual(nodeNamed(row, label)?.state, "settled", label);
        }

        assert.deepStrictEqual(starts(effects, "start"), ["a", "b", "c", "d"]);
        assert.deepStrictEqual(starts(effects, "done"), ["a", "c", "d"]);

        // The stopped node's child spoke before the stop: its receipt keeps that, and the
        // workflow's spend and the script's budget reading count it.
        const receipt = b?.receipt ?? null;

        assert.isNotNull(receipt);
        assert.isAbove(receipt?.totalTokens ?? 0, 0);
        assert.strictEqual(row.spent.tokens, settledTokens(row));

        const spent = /"spent":(?<n>\d+)/u.exec(result)?.groups?.n;

        assert.isAtLeast(Number(spent), receipt?.totalTokens ?? 0);
      }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );

  it.live(
    "stops a whole workflow: the running nodes stop, nothing more is dispatched",
    () =>
      Effect.gen(function* () {
        const { brain, effects } = yield* kit(FAN);

        const outcome = yield* Effect.promise(async () => {
          await runScript(brain, FAN, "run-1", context);
          await running(brain, "b");
          await waitFor(brain, (row) =>
            nodeNamed(row, "a")?.state === "settled" ? true : undefined
          );

          return {
            stopped: await stopWorkflowIn(
              brain.harness,
              brain.root,
              WF,
              5,
              context
            ),
            row: await ended(brain),
          };
        });

        assert.strictEqual(kindOf(outcome.stopped), "aborted");

        const { row } = outcome;

        assert.strictEqual(row.state, "stopped");
        assert.deepStrictEqual(row.outcome, {
          kind: "partial",
          reason: "stopped",
        });
        assert.strictEqual(nodeNamed(row, "a")?.state, "settled");
        assert.strictEqual(nodeNamed(row, "b")?.state, "stopped");
        assert.isUndefined(nodeNamed(row, "d"));
        assert.notInclude(starts(effects, "done"), "b");
      }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );

  it.live(
    "stops an approved workflow before its script runs: the script is then refused",
    () =>
      Effect.gen(function* () {
        const { brain, effects } = yield* kit(FAN);

        const outcome = yield* Effect.promise(async () => {
          const stopped = await stopWorkflowIn(
            brain.harness,
            brain.root,
            WF,
            5,
            context
          );

          await runScript(brain, FAN, "run-1", context);
          await brain.harness.waitForIdle(context);

          return {
            stopped,
            row: await rowOf(brain),
            result: await codemodeResultText(brain, context),
          };
        });

        assert.strictEqual(kindOf(outcome.stopped), "stopped_before_start");
        assert.strictEqual(outcome.row?.state, "stopped");
        assert.strictEqual(outcome.row?.endedAt, 5);
        assert.deepStrictEqual(Object.keys(outcome.row?.nodes ?? {}), []);
        assert.deepStrictEqual(effects, []);
        assert.include(outcome.result, "no approved launch");
      }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );

  it.live(
    "answers not found, not started and ended without changing anything",
    () =>
      Effect.gen(function* () {
        const { brain } = yield* kit(FAN);

        const outcome = yield* Effect.promise(async () => {
          const missing = await stopWorkflowIn(
            brain.harness,
            brain.root,
            "wf-none",
            5,
            context
          );

          const missingNode = await stopNodeIn(
            brain.harness,
            brain.root,
            WF,
            "n-none",
            context
          );

          await brain.harness.commit(async (tx) => {
            const ledger = await tx.doc(WorkflowsDoc, brain.root);
            const row = ledger.items[WF];

            if (row !== undefined) {
              row.state = "proposed";
            }
          }, context);

          const proposed = await stopWorkflowIn(
            brain.harness,
            brain.root,
            WF,
            5,
            context
          );

          await brain.harness.commit(async (tx) => {
            const ledger = await tx.doc(WorkflowsDoc, brain.root);
            const row = ledger.items[WF];

            if (row !== undefined) {
              row.state = "finished";
            }
          }, context);

          const finished = await stopWorkflowIn(
            brain.harness,
            brain.root,
            WF,
            5,
            context
          );

          return {
            missing,
            missingNode,
            proposed,
            finished,
            row: await rowOf(brain),
          };
        });

        assert.deepStrictEqual(outcome.missing, {
          kind: "not_found",
          resource: "workflow",
        });
        assert.deepStrictEqual(outcome.missingNode, {
          kind: "not_found",
          resource: "node",
        });
        assert.deepStrictEqual(outcome.proposed, { kind: "not_started" });
        assert.deepStrictEqual(outcome.finished, {
          kind: "ended",
          state: "finished",
        });
        assert.isNull(outcome.row?.outcome ?? null);
      }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );
});

describe("abort polling in the node tools", () => {
  const HOLD_MS = 3000;

  /** Stops node b while it is held after its reserve; answers how long the stop took. */
  const stopHeld = (faults: WorkflowFaultSet) =>
    Effect.gen(function* () {
      const { brain, effects } = yield* kit(FAN, {
        faults,
        hold: { point: "after-reserve", label: "b", ms: HOLD_MS },
      });

      return yield* Effect.promise(async () => {
        await runScript(brain, FAN, "run-1", context);

        const b = await running(brain, "b");

        await pause(100);

        const started = performance.now();

        await stopNodeIn(brain.harness, brain.root, WF, b.id, context);

        const tookMs = performance.now() - started;
        const row = await ended(brain);

        return { tookMs, row, effects };
      });
    }).pipe(Effect.scoped, Effect.provide(KitLayer));

  it.live("a node held in a deaf wait stops at once", () =>
    Effect.gen(function* () {
      const outcome = yield* stopHeld(NO_WORKFLOW_FAULTS);

      assert.isBelow(outcome.tookMs, 1000);
      assert.strictEqual(nodeNamed(outcome.row, "b")?.state, "stopped");
      assert.notInclude(starts(outcome.effects, "start"), "b");
      assert.strictEqual(outcome.row.state, "finished");
    })
  );

  it.live(
    "the deaf control waits the hold out, so the check above can fail",
    () =>
      Effect.gen(function* () {
        const outcome = yield* stopHeld({
          ...NO_WORKFLOW_FAULTS,
          deafToStop: true,
        });

        assert.isAtLeast(outcome.tookMs, HOLD_MS - 500);
        assert.strictEqual(nodeNamed(outcome.row, "b")?.state, "stopped");
      }),
    20_000
  );
});

describe("the stop service behind the RPCs", () => {
  it.live("answers each outcome as the RPCs do", () =>
    Effect.gen(function* () {
      const { brain } = yield* kit(FAN);

      const stops = WorkflowStops.make(Effect.succeed(brain.harness), () => 9);

      const unknownThread = yield* Effect.result(
        stops.stop({
          threadId: ThreadId.make("01900000-0000-7000-8000-0000000000ff"),
          workflowId: WF,
        })
      );

      const missingNode = yield* Effect.result(
        stops.stopNode({ threadId: THREAD, workflowId: WF, nodeId: "n-none" })
      );

      const stopped = yield* Effect.result(
        stops.stop({ threadId: THREAD, workflowId: WF })
      );

      const again = yield* Effect.result(
        stops.stop({ threadId: THREAD, workflowId: WF })
      );

      const row = yield* Effect.promise(async () => await rowOf(brain));

      assert.isTrue(
        Result.isFailure(unknownThread) &&
          Predicate.isTagged(unknownThread.failure, "NotFound") &&
          unknownThread.failure.resource === "thread"
      );

      assert.isTrue(
        Result.isFailure(missingNode) &&
          Predicate.isTagged(missingNode.failure, "NotFound") &&
          missingNode.failure.resource === "node"
      );
      assert.isTrue(Result.isSuccess(stopped));
      assert.isTrue(Result.isSuccess(again));
      assert.strictEqual(row?.state, "stopped");
      assert.strictEqual(row?.endedAt, 9);
    }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );

  it.live("refuses a proposed workflow with Conflict", () =>
    Effect.gen(function* () {
      const { brain } = yield* kit(FAN);

      yield* Effect.promise(async () => {
        await brain.harness.commit(async (tx) => {
          const ledger = await tx.doc(WorkflowsDoc, brain.root);
          const row = ledger.items[WF];

          if (row !== undefined) {
            row.state = "proposed";
          }
        }, context);
      });

      const stops = WorkflowStops.make(Effect.succeed(brain.harness), () => 9);

      const answer = yield* Effect.result(
        stops.stop({ threadId: THREAD, workflowId: WF })
      );

      assert.isTrue(
        Result.isFailure(answer) &&
          Predicate.isTagged(answer.failure, "Conflict")
      );
    }).pipe(Effect.scoped, Effect.provide(KitLayer))
  );
});
