// Workflows note judge 10 (slots): a workflow script holds its code mode slot for its whole run, so
// workflows take theirs from a pool of their own (`MAX_WORKFLOW_WORKERS`). Workflow scripts filling
// every workflow slot must not delay another thread's code mode, and scripts filling the shared
// slots must not delay a workflow. The control is one shared pool, where the plain script waits.
//
// A holder is a script waiting on a call nobody answers, as a workflow waits on its nodes: here a
// rewritten workflow waiting on `workflow_begin`, or a plain script waiting on a tool.

import type { CodemodeRunOptions } from "@earendil-works/pi-codemode";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Function, Option } from "effect";

import {
  MAX_WORKFLOW_WORKERS,
  ScriptSlots,
  WaitingSandbox,
} from "../brain/CodeMode.ts";
import { isRewrittenWorkflow, rewriteScript } from "./Prelude.ts";
import { parseWorkflowScript } from "./WorkflowScript.ts";

const SANDBOX = {
  memoryLimitBytes: 64 * 1024 * 1024,
  timeoutMs: Number.POSITIVE_INFINITY,
};

/** A rewritten workflow script, waiting on its first call (`workflow_begin`) until answered. */
const holdingWorkflow = Effect.gen(function* () {
  const script = yield* parseWorkflowScript(
    'export const meta = { name: "hold", description: "Holds its slot" };\nreturn 1;'
  );

  return rewriteScript(script, {
    workflowId: "wf-hold",
    sample: Option.none(),
    budgetTokens: Option.none(),
    args: {},
  });
});

/** A plain script waiting on a tool nobody answers. */
const HOLDING_SCRIPT = "return await tools.wait({});";

/**
 * A script the slot pools take for a workflow (its text holds the rewrite's mark, here in a
 * string) that ends at once.
 */
const QUICK_WORKFLOW = "return `\n});\n/* Cairn workflow prelude v2 */`;";

const start = (sandbox: WaitingSandbox, code: string, signal: AbortSignal) => {
  const options: CodemodeRunOptions = {
    startedAt: 0,
    seed: 1,
    tools: [{ name: "workflow_begin" }, { name: "wait" }],
    onCall: Function.constVoid,
    signal,
  };

  return sandbox.start(code, options);
};

/** A signal a case ends by hand once it has looked; Effect's own would end with the fiber. */
const stopper = () => new AbortController();

/** Starts `holders` scripts that never end, then a quick one; whether the quick one finished. */
const quickFinishes = Effect.fn("WorkflowSlots.quickFinishes")(function* (
  sandbox: WaitingSandbox,
  holder: string,
  holders: number,
  quick: string
) {
  const stop = stopper();

  const held = Array.from({ length: holders }, () =>
    start(sandbox, holder, stop.signal)
  );

  const run = start(sandbox, quick, stop.signal);

  yield* Effect.sleep(400);

  const holdersFinished = held.some((each) => each.finished);
  const { finished } = run;

  stop.abort();

  yield* Effect.promise(
    async () =>
      await Promise.all([...held, run].map(async (each) => await each.result))
  );

  yield* Effect.promise(async () => {
    await sandbox.close();
  });

  assert.isFalse(holdersFinished, "every holder still holds its slot");

  return finished;
});

describe("workflow script slots", () => {
  it.live(
    "a workflow's script is told apart from a plain one by the rewrite",
    () =>
      Effect.gen(function* () {
        const workflow = yield* holdingWorkflow;

        assert.isTrue(isRewrittenWorkflow(workflow));
        assert.isTrue(isRewrittenWorkflow(QUICK_WORKFLOW));
        assert.isFalse(isRewrittenWorkflow(HOLDING_SCRIPT));
      })
  );

  it.live(
    "workflows filling their pool do not delay another thread's code mode",
    () =>
      Effect.gen(function* () {
        const workflow = yield* holdingWorkflow;

        const sandbox = new WaitingSandbox(
          SANDBOX,
          new ScriptSlots(1),
          new ScriptSlots(2)
        );

        assert.isTrue(yield* quickFinishes(sandbox, workflow, 2, "return 2;"));
      })
  );

  it.live(
    "plain scripts filling the shared slots do not delay a workflow",
    () =>
      Effect.gen(function* () {
        const sandbox = new WaitingSandbox(
          SANDBOX,
          new ScriptSlots(2),
          new ScriptSlots(1)
        );

        assert.isTrue(
          yield* quickFinishes(sandbox, HOLDING_SCRIPT, 2, QUICK_WORKFLOW)
        );
      })
  );

  it.live(
    "control: with one shared pool, the plain script waits behind workflows",
    () =>
      Effect.gen(function* () {
        const workflow = yield* holdingWorkflow;
        const shared = new ScriptSlots(2);
        const sandbox = new WaitingSandbox(SANDBOX, shared, shared);

        assert.isFalse(yield* quickFinishes(sandbox, workflow, 2, "return 2;"));
      })
  );

  it("the workflow pool is twice code mode's own", () => {
    assert.strictEqual(MAX_WORKFLOW_WORKERS, 8);
  });
});
