// The judge brain of `judges/workflow-kill.ts` (workflows note judges 1 and 2): a pi-durable Harness
// over SQLite in the run's directory, with Cairn's code mode extension (its slot pools), the
// workflows extension and its gate, and the results extension, over the kit's faux model
// (apps/server/src/workflows/WorkflowTestKit.ts). Never the deployed brain or the user's store. The
// orchestrator `kill -9`s it at the moments its case names; each life opens the same store.
//
//   node judges/fixtures/workflows/WorkflowBrain.ts --dir <run> --script <file>
//     [--hold <point>:<label>:<ms>] [--stop <label>:<ms>] [--answer] [--defer-run]
//     [--diverge] [--control]
//
// - The first life plants an approved launch of the script (as 5A's answer path will) unless the
//   ledger has it; every life submits the run under one request id, so it is admitted once.
//   `--defer-run` plants and waits without submitting: a kill between Go and the codemode call.
// - Each node's child calls `work`, which appends `{node, what}` to `effects.log` (outside the
//   store): `start` once per child (a memo guards it), then `done` or `aborted`.
// - `--hold point:label:ms` holds that node there for `ms` (`holding <point> <label>` is printed).
// - `--stop label:ms` stops that node `ms` after it runs (`harness.abortTask` on its nested task),
//   once across lives (`stop-requested` in the run's directory), printing `stopped <label>`.
// - `--answer` answers every pending `approve` record with accept.
// - `--diverge` rewrites the stored code mode start data's version before the Harness resumes,
//   as a pi bump would: the script call must end with an error and dispatch nothing again.
// - `--control` plants `freshDispatch`: each attempt of a node dispatches anew.
//
// It prints `node <label> <state>`, `workflow <state>`, `approval-pending` and `effect <node>
// <what>` as they happen, and `done` once the workflow ended and `report.json` is written.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Predicate } from "effect";

import { Approvals } from "../../../apps/server/src/brain/CairnDocs.ts";
import { taskOf } from "../../../apps/server/src/subagents/Delivery.ts";
import { ChildDoc } from "../../../apps/server/src/subagents/SubagentDocs.ts";
import { PRELUDE_MARK } from "../../../apps/server/src/workflows/Prelude.ts";
import {
  isWorkflowEnded,
  ledgerProblems,
  WorkflowsDoc,
} from "../../../apps/server/src/workflows/WorkflowDocs.ts";
import type { WorkflowItemState } from "../../../apps/server/src/workflows/WorkflowDocs.ts";
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
    stop: { type: "string" },
    answer: { type: "boolean", default: false },
    "defer-run": { type: "boolean", default: false },
    diverge: { type: "boolean", default: false },
    control: { type: "boolean", default: false },
  },
});

const dir = path.resolve(values.dir ?? ".");

const source = readFileSync(path.resolve(values.script ?? ""), "utf-8");

const WF = "wf-1";

const context = BACKGROUND_CONTEXT;

const say = (line: string) => {
  process.stdout.write(`${line}\n`);
};

const [holdPoint, holdLabel, holdMs] = (values.hold ?? "::0").split(":");

const [stopLabel, stopMs] = (values.stop ?? ":0").split(":");

const stopMarker = path.join(dir, "stop-requested");

/** The stored start data of a code mode call: its doc, as pi-durable defines it (`pi.codemode.run`). */
const CodemodeRunDoc = defineDoc<{ [key: string]: JsonValue }>({
  kind: "pi.codemode.run",
  version: 1,
  scope: "task",
  initial: () => ({}),
  checkpointWhen: () => false,
});

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

/** What one life has printed already, so each change prints once. */
type Seen = Map<string, string>;

/** Rewrites the stored code mode start data's version, as a pi bump between lives would. */
const diverge = async (brain: KitBrain) => {
  const ledger = await brain.harness.snapshot(
    WorkflowsDoc,
    brain.root,
    context
  );

  const task = ledger?.items[WF]?.codemodeTaskId ?? null;

  if (task === null) {
    return;
  }

  await brain.harness.commit(async (tx) => {
    const run = await tx.doc(CodemodeRunDoc, taskOf(task));
    const { start } = run;

    if (Predicate.isObject(start) && !Array.isArray(start)) {
      start.version = 999;
      say("diverged");
    }
  }, context);
};

/** Prints each node's new state, and stops the `--stop` node once, `stopMs` after it runs. */
const followNodes = async (
  brain: KitBrain,
  row: Readonly<WorkflowItemState>,
  seen: Seen
) => {
  for (const node of Object.values(row.nodes)) {
    if (seen.get(node.label) !== node.state) {
      seen.set(node.label, node.state);
      say(`node ${node.label} ${node.state}`);
    }

    const due =
      node.label === stopLabel &&
      node.state === "running" &&
      node.nestedTaskId !== null &&
      !existsSync(stopMarker);

    if (due && node.nestedTaskId !== null) {
      // oxlint-disable-next-line no-await-in-loop
      await sleep(Number(stopMs));
      writeFileSync(stopMarker, "1");
      // oxlint-disable-next-line no-await-in-loop
      await brain.harness.abortTask(taskOf(node.nestedTaskId), context);
      say(`stopped ${node.label}`);
    }
  }
};

/** Records once per life whether the running script call stores the gate's rewrite. */
const noteStored = async (
  brain: KitBrain,
  row: Readonly<WorkflowItemState>,
  seen: Seen
) => {
  if (
    seen.has("<stored>") ||
    row.state !== "running" ||
    row.codemodeTaskId === null
  ) {
    return;
  }

  const task = await brain.harness.getTask(taskOf(row.codemodeTaskId), context);

  if (task === undefined || task.state.status === "terminal") {
    return;
  }

  const rewritten = String(JSON.stringify(task).includes(PRELUDE_MARK));

  seen.set("<stored>", rewritten);
  appendFileSync(path.join(dir, "stored.log"), `${rewritten}\n`);
  say(`stored ${rewritten}`);
};

/** Prints a pending `approve` record once, and with `--answer` accepts it. */
const followApprovals = async (brain: KitBrain, seen: Seen) => {
  const approvals = await brain.harness.snapshot(
    Approvals,
    brain.root,
    context
  );

  const pending = Object.values(approvals?.items ?? {}).filter(
    (record) => record.tool === "approve" && record.status === "pending"
  );

  for (const record of pending) {
    if (!seen.has(record.id)) {
      seen.set(record.id, "pending");
      say("approval-pending");
    }
  }

  if (!values.answer || pending.length === 0) {
    return;
  }

  await brain.harness.commit(async (tx) => {
    const doc = await tx.doc(Approvals, brain.root);

    for (const record of pending) {
      const current = doc.items[record.id];

      if (current?.status === "pending") {
        current.status = "accepted";
        current.answeredAt = 2;
        current.decidedBy = { kind: "user" };
        current.answer = {
          decision: "accept",
          answers: null,
          note: null,
          launch: null,
        };
      }
    }
  }, context);
};

/** Follows the run until the workflow row has ended. */
const follow = async (brain: KitBrain) => {
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
      await followNodes(brain, row, seen);
      // oxlint-disable-next-line no-await-in-loop
      await noteStored(brain, row, seen);
    }

    // oxlint-disable-next-line no-await-in-loop
    await followApprovals(brain, seen);

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

  const storedFile = path.join(dir, "stored.log");

  const stored = existsSync(storedFile)
    ? readFileSync(storedFile, "utf-8")
        .split("\n")
        .filter((line) => line !== "")
    : [];

  const report = {
    result: await codemodeResultText(brain, context),
    workflow: ledger?.items[WF] ?? null,
    children: await childrenOf(brain),
    approveRecords: Object.values(approvals?.items ?? {}).filter(
      (record) => record.tool === "approve"
    ).length,
    problems: ledgerProblems(ledger ?? { items: {} }, approvals?.items ?? {}),
    /** Each life that saw its script call running: whether it stored the gate's rewrite. */
    storedRewrites: stored.map((line) => line === "true"),
  };

  writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
};

const program = Effect.gen(function* () {
  const parts = yield* kitParts({
    faults: { freshDispatch: values.control },
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
    say("planted");
  }

  if (values.diverge) {
    yield* Effect.promise(async () => {
      await diverge(brain);
    });
  }

  brain.harness.resume();

  return yield* Effect.promise(async () => {
    if (values["defer-run"]) {
      say("deferred");
      await sleep(60_000);
    }

    await runScript(brain, source, "run-1", context);
    say("producing");
    await follow(brain);
    await brain.harness.waitForIdle(context);
    await writeReport(brain);
    say("done");
    await brain.harness.close(context);
    process.exit(0);
  });
}).pipe(Effect.scoped, Effect.provide(KitLayer));

NodeRuntime.runMain(program);
