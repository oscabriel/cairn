// The judge brain of `judges/workflow-stop.ts` (workflows note judge 2, plan 5C): a pi-durable
// Harness over SQLite in the run's directory, with Cairn's code mode extension, the workflows
// extension and its gate, and the results extension, over the kit's faux model
// (apps/server/src/workflows/WorkflowTestKit.ts). Never the deployed brain or the user's store. The
// judge `kill -9`s it at the moments its case names; each life opens the same store.
//
// Every stop goes through `WorkflowStops` (WorkflowStop.ts), the service behind the
// `workflow.stop` and `workflow.stopNode` RPCs, by thread id, as a client's stop would.
//
//   node judges/fixtures/workflows/StopBrain.ts --dir <run> --script <file>
//     [--hold <point>:<label>:<ms>] [--stop-node <label>:<ms>] [--stop-workflow <label>:<ms>]
//     [--stop-before-run] [--deaf]
//
// - The first life plants an approved launch of the script (as 5A's answer path writes one) and
//   the root thread's receipt; every life submits the run under one request id.
// - Each node's child calls `work`, which appends `{node, what}` to `effects.log` (outside the
//   store): `start` once per child, then `done` or `aborted`.
// - `--stop-node label:ms` stops that node `ms` after it runs; `--stop-workflow label:ms` stops the
//   whole workflow `ms` after that node runs. Each once across lives (`stop-requested` in the run's
//   directory). It prints `stopping <what>` before the call and `stopped <what> <ms>` after, and
//   appends the call's milliseconds to `stop-ms.log`.
// - `--stop-before-run` stops the approved workflow before the run is submitted (Go given, no
//   `codemode` call yet), then submits it: the script must be refused and nothing dispatched.
// - `--hold point:label:ms` holds that node there for `ms` (`holding <point> <label>`).
// - `--deaf` plants the `deafToStop` fault: node tools ignore the stop in their waits.
//
// It prints `node <label> <state>`, `workflow <state>`, `effect <node> <what>`, and `done` once the
// workflow ended and `report.json` is written.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import { ThreadId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Result } from "effect";

import {
  Approvals,
  ThreadReceipt,
} from "../../../apps/server/src/brain/CairnDocs.ts";
import { ChildDoc } from "../../../apps/server/src/subagents/SubagentDocs.ts";
import {
  isWorkflowEnded,
  ledgerProblems,
  WorkflowsDoc,
} from "../../../apps/server/src/workflows/WorkflowDocs.ts";
import type { WorkflowItemState } from "../../../apps/server/src/workflows/WorkflowDocs.ts";
import { WorkflowStops } from "../../../apps/server/src/workflows/WorkflowStop.ts";
import {
  codemodeResultText,
  kitParts,
  KitLayer,
  openKit,
  plant,
  plantDefaults,
  runScript,
} from "../../../apps/server/src/workflows/WorkflowTestKit.ts";
import type {
  KitBrain,
  WorkEffect,
} from "../../../apps/server/src/workflows/WorkflowTestKit.ts";
import type { HoldPoint } from "../../../apps/server/src/workflows/WorkflowTools.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    script: { type: "string" },
    hold: { type: "string" },
    "stop-node": { type: "string" },
    "stop-workflow": { type: "string" },
    "stop-before-run": { type: "boolean", default: false },
    deaf: { type: "boolean", default: false },
  },
});

const dir = path.resolve(values.dir ?? ".");

const source = readFileSync(path.resolve(values.script ?? ""), "utf-8");

const WF = "wf-1";

/** The root thread's id, as a client names it in the stop RPCs. */
const THREAD = ThreadId.make("01900000-0000-7000-8000-00000000c5c0");

const context = BACKGROUND_CONTEXT;

const say = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const [holdPoint, holdLabel, holdMs] = (values.hold ?? "::0").split(":");

/** The one stop this life may make: whom, after which node runs, how long after. */
const stopSpec = (() => {
  const node = values["stop-node"];
  const whole = values["stop-workflow"];
  const [label = "", ms = "0"] = (node ?? whole ?? ":0").split(":");

  const kind = (): "node" | "workflow" | "none" => {
    if (node !== undefined) {
      return "node";
    }

    return whole === undefined ? "none" : "workflow";
  };

  return { kind: kind(), label, ms: Number(ms) };
})();

const stopMarker = path.join(dir, "stop-requested");

const hold = async (point: HoldPoint, label: string) => {
  if (point === holdPoint && label === holdLabel) {
    say(`holding ${point} ${label}`);
    await sleep(Number(holdMs));
  }
};

const effect = (line: WorkEffect) => {
  appendFileSync(path.join(dir, "effects.log"), `${JSON.stringify(line)}\n`);
  say(`effect ${line.node} ${line.what}`);
};

/** Runs an Effect from the brain's plain-JS loop: set once the program's context exists. */
let runEffect: <A, E>(effect: Effect.Effect<A, E>) => Promise<A> = async () =>
  await Promise.reject(new Error("the brain's runtime is not up yet"));

/** Runs one stop through the service, timing it; records it once across lives. */
const stopThrough = async (
  what: string,
  call: Effect.Effect<void, { readonly message: string }>
) => {
  writeFileSync(stopMarker, "1");
  say(`stopping ${what}`);

  const started = performance.now();
  const answer = await runEffect(Effect.result(call));
  const ms = Math.round(performance.now() - started);

  appendFileSync(path.join(dir, "stop-ms.log"), `${String(ms)}\n`);
  say(
    Result.match(answer, {
      onSuccess: () => `stopped ${what} ${String(ms)}`,
      onFailure: (failure) => `stop-refused ${what}: ${failure.message}`,
    })
  );
};

type Seen = Map<string, string>;

/** Prints each node's new state, and makes the life's stop once its node has run `ms`. */
const followNodes = async (
  stops: WorkflowStops["Service"],
  row: Readonly<WorkflowItemState>,
  seen: Seen
) => {
  for (const node of Object.values(row.nodes)) {
    if (seen.get(node.label) !== node.state) {
      seen.set(node.label, node.state);
      say(`node ${node.label} ${node.state}`);
    }

    const due =
      stopSpec.kind !== "none" &&
      node.label === stopSpec.label &&
      node.state === "running" &&
      !existsSync(stopMarker);

    if (!due) {
      continue;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(stopSpec.ms);

    // oxlint-disable-next-line no-await-in-loop
    await (stopSpec.kind === "node"
      ? stopThrough(
          node.label,
          stops.stopNode({ threadId: THREAD, workflowId: WF, nodeId: node.id })
        )
      : stopThrough(
          "workflow",
          stops.stop({ threadId: THREAD, workflowId: WF })
        ));
  }
};

/** Follows the run until the workflow row has ended. */
const follow = async (brain: KitBrain, stops: WorkflowStops["Service"]) => {
  const seen: Seen = new Map();

  for (;;) {
    // oxlint-disable-next-line no-await-in-loop
    const ledger = await brain.harness.snapshot(
      WorkflowsDoc,
      brain.root,
      context
    );

    const row = ledger?.items[WF];
    const state = row?.state ?? "none";

    if (seen.get("<workflow>") !== state) {
      seen.set("<workflow>", state);
      say(`workflow ${state}`);
    }

    if (row !== undefined) {
      // oxlint-disable-next-line no-await-in-loop
      await followNodes(stops, row, seen);
    }

    if (row !== undefined && isWorkflowEnded(row.state)) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(25);
  }
};

/** Every conversation a node created, by its link's node id: outside the ledger's own word. */
const childrenOf = async (brain: KitBrain) =>
  await brain.harness.commit(async (tx) => {
    const found: Record<string, number> = {};
    const page = await tx.scanConversations({}, 1000);

    for (const conversation of page.items) {
      if (conversation.id !== brain.root) {
        // oxlint-disable-next-line no-await-in-loop
        const link = await tx.doc(ChildDoc, conversation.id);

        if (link.parentConversationId === brain.root) {
          found[link.key] = (found[link.key] ?? 0) + 1;
        }
      }
    }

    return found;
  }, context);

const readLines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

/** Writes `report.json` for the judge. */
const writeReport = async (brain: KitBrain) => {
  const ledger = await brain.harness.snapshot(
    WorkflowsDoc,
    brain.root,
    context
  );

  const approvals = await brain.harness.snapshot(
    Approvals,
    brain.root,
    context
  );

  const report = {
    result: await codemodeResultText(brain, context),
    workflow: ledger?.items[WF] ?? null,
    children: await childrenOf(brain),
    problems: ledgerProblems(ledger ?? { items: {} }, approvals?.items ?? {}),
    stopMs: readLines(path.join(dir, "stop-ms.log")).map(Number),
  };

  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
};

const program = Effect.gen(function* () {
  const parts = yield* kitParts({
    faults: {
      freshDispatch: false,
      grantAll: false,
      ignoreBudget: false,
      deafToStop: values.deaf,
    },
    hold,
    effect,
    tokensPerSecond: 20_000,
  });

  const storage = yield* Effect.promise(
    async () => await openNodeSqliteStorage(path.join(dir, "store.sqlite"))
  );

  const brain = yield* Effect.promise(
    async () =>
      await openKit(storage, parts, context, (text) => {
        appendFileSync(path.join(dir, "reports.log"), `${text}\n`);
      })
  );

  const ledger = yield* Effect.promise(
    async () => await brain.harness.snapshot(WorkflowsDoc, brain.root, context)
  );

  if (ledger?.items[WF] === undefined) {
    yield* plant(brain, source, plantDefaults(WF), context);
    yield* Effect.promise(async () => {
      await brain.harness.commit(async (tx) => {
        const receipt = await tx.doc(ThreadReceipt, THREAD, {
          conversationId: 0,
        });

        receipt.conversationId = brain.root;
      }, context);
    });
    say("planted");
  }

  const stops = WorkflowStops.make(Effect.succeed(brain.harness), () =>
    Date.now()
  );

  runEffect = Effect.runPromiseWith(yield* Effect.context());
  brain.harness.resume();

  return yield* Effect.promise(async () => {
    if (values["stop-before-run"] && !existsSync(stopMarker)) {
      await stopThrough(
        "workflow",
        stops.stop({ threadId: THREAD, workflowId: WF })
      );
    }

    await runScript(brain, source, "run-1", context);
    say("producing");
    await follow(brain, stops);
    await brain.harness.waitForIdle(context);
    await writeReport(brain);
    say("done");
    await brain.harness.close(context);
    process.exit(0);
  });
}).pipe(Effect.scoped, Effect.provide(KitLayer));

NodeRuntime.runMain(program);
