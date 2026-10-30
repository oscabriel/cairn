// Workflow budgets and the meter (5B, workflows note W5, ADR 0036): the pure rules (where a run
// stands, the budget as raised, a response's price), then each rule on a real pi-durable Harness
// with the code mode, workflows and results extensions over the kit's faux model, the budget
// reactor driven as the reactor host drives it: admission refuses past the line, each line fires
// once, the stopper ends running nodes, a raise opens a new epoch, and a usage limit holds a node.

import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Option, Predicate } from "effect";

import { Approvals } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { taskOf } from "../subagents/Delivery.ts";
import {
  effectiveBudget,
  raisedBudget,
  responsePrice,
  RAISE_TOOL,
  spendOf,
  STOPPER_TASK,
  standingOf,
  workflowBudgetReactor,
  workflowRaiseIdOf,
} from "./WorkflowBudget.ts";
import type { WorkflowBudgetPush } from "./WorkflowBudget.ts";
import type { BudgetState, WorkflowItemState } from "./WorkflowDocs.ts";
import { isWorkflowEnded, WorkflowsDoc } from "./WorkflowDocs.ts";
import { BUDGET_STOP_TEXT } from "./WorkflowNodes.ts";
import { parkedWorkflowTasks } from "./WorkflowRepairs.ts";
import {
  codemodeResultText,
  driveReactors,
  eventsOf,
  kitParts,
  KitLayer,
  openKit,
  pause,
  plant,
  plantDefaults,
  runScript,
} from "./WorkflowTestKit.ts";
import type { KitBrain, KitEvent, WorkEffect } from "./WorkflowTestKit.ts";
import {
  CONTINUE_TEXT,
  NO_WORKFLOW_FAULTS,
  WATCH_TASK,
} from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

const WF = "wf-1";

/** Padding after a node prompt's first line: about a thousand tokens of input per response. */
const PAD = `\n${"lorem ipsum ".repeat(340)}`;

const budgetOf = (patch: Partial<BudgetState>): BudgetState => ({
  maxListMicros: null,
  maxTokens: null,
  maxTurns: null,
  maxMinutes: null,
  planGuard: null,
  warnAt: 0.8,
  ...patch,
});

describe("where a run stands", () => {
  const meter = { tokens: 800, listMicros: 0, unpricedTokens: 800, turns: 3 };

  it("warns at warnAt and reaches a limit at its line", () => {
    const soft = standingOf(budgetOf({ maxTokens: 1000 }), meter, 0);

    assert.isTrue(soft.warn);
    assert.isTrue(Option.isNone(soft.reached));

    const reached = standingOf(budgetOf({ maxTokens: 800 }), meter, 0);

    assert.deepStrictEqual(reached.reached, Option.some("tokens"));
  });

  it("binds turns and minutes, and a dollar line binds priced tokens only", () => {
    assert.deepStrictEqual(
      standingOf(budgetOf({ maxTurns: 3 }), meter, 0).reached,
      Option.some("turns")
    );
    assert.deepStrictEqual(
      standingOf(budgetOf({ maxMinutes: 1 }), meter, 60_000).reached,
      Option.some("minutes")
    );
    // Every token unpriced: a dollar line sees nothing spent.
    assert.isFalse(standingOf(budgetOf({ maxListMicros: 10 }), meter, 0).warn);
  });

  it("never warns a budget with no limit", () => {
    const none = standingOf(budgetOf({}), meter, 10 ** 9);

    assert.isFalse(none.warn);
    assert.isTrue(Option.isNone(none.reached));
  });

  it("raises each reached line to the larger of double it and the use plus it", () => {
    const raised = raisedBudget(
      budgetOf({ maxTokens: 500, maxTurns: 10 }),
      meter,
      0
    );

    assert.strictEqual(raised.maxTokens, 1300);
    assert.strictEqual(raised.maxTurns, 10);
  });
});

/** A record as the reactor asks a raise; `status` and when it was answered as given. */
const raiseRecord = (
  workflowId: string,
  epoch: number,
  to: Budget,
  status: ApprovalRecord["status"],
  answeredAt: number | null
): ApprovalRecord => ({
  id: workflowRaiseIdOf(workflowId, epoch),
  toolTaskId: 0,
  tool: RAISE_TOOL,
  kind: "tool-call",
  summary: "raise",
  status,
  askedAt: epoch,
  expiresAt: 10 ** 12,
  answeredAt,
  run: null,
  executorRequestId: null,
  payload: {
    type: "budget-raise",
    scope: workflowId,
    from: { ...DEFAULT_BUDGET },
    to: { ...to, planGuard: null },
  },
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
});

describe("the budget as raised", () => {
  const row = {
    id: WF,
    budget: budgetOf({ maxTokens: 100 }),
    spentAt: 50,
  } as const;

  it("takes each accepted raise of this workflow, oldest first, and counts the epoch", () => {
    const approvals = {
      a: raiseRecord(
        WF,
        0,
        { ...DEFAULT_BUDGET, maxTokens: 200 },
        "accepted",
        60
      ),
      b: raiseRecord(
        WF,
        1,
        { ...DEFAULT_BUDGET, maxTokens: 400 },
        "declined",
        70
      ),
      c: raiseRecord(
        "wf-9",
        0,
        { ...DEFAULT_BUDGET, maxTokens: 900 },
        "accepted",
        80
      ),
    };

    const effective = effectiveBudget(row, approvals);

    assert.strictEqual(effective.budget.maxTokens, 200);
    assert.strictEqual(effective.epoch, 1);
    assert.deepStrictEqual(effective.raisedAt, Option.some(60));
  });
});

/** A response of 1,000 input and 1,000 output tokens from `provider/m`, recording `cost`. */
const message = (cost: number, provider: string): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "faux",
  provider,
  model: "m",
  usage: {
    input: 1000,
    output: 1000,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2000,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: cost,
    },
  },
  stopReason: "stop",
  timestamp: 0,
});

/** A catalog with `metered/m` at $3 in and $15 out per million tokens, and `free/m` at no price. */
const catalog = () => {
  const models = createModels();

  for (const [provider, rates] of [
    ["metered", { input: 3, output: 15 }],
    ["free", { input: 0, output: 0 }],
  ] as const) {
    models.setProvider(
      fauxProvider({
        provider,
        models: [{ id: "m", cost: { ...rates, cacheRead: 0, cacheWrite: 0 } }],
      }).provider
    );
  }

  return models;
};

describe("a response's price", () => {
  it("keeps a recorded cost, prices a zero-cost response from the catalog, and leaves none unpriced", () => {
    const models = catalog();

    assert.deepStrictEqual(
      responsePrice(models, message(0.25, "free")),
      Option.some(250_000)
    );
    assert.deepStrictEqual(
      responsePrice(models, message(0, "metered")),
      Option.some(18_000)
    );
    assert.isTrue(Option.isNone(responsePrice(models, message(0, "free"))));
  });

  it("counts tokens no response accounts for as unpriced", () => {
    const spend = spendOf(
      {
        after: 9,
        responseTokens: 100,
        listMicros: 40,
        unpricedTokens: 0,
        turns: 1,
        pricedResponses: 1,
      },
      {
        models: {
          "a/b": {
            input: 120,
            output: 30,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        tools: {},
      }
    );

    assert.strictEqual(spend.tokens, 150);
    assert.strictEqual(spend.unpricedTokens, 50);
    assert.strictEqual(spend.listMicros, 40);
  });
});

// On a Harness.

/** What one run leaves behind. */
interface Outcome {
  readonly row: WorkflowItemState;
  readonly result: string;
  readonly events: ReadonlyArray<KitEvent>;
  readonly effects: ReadonlyArray<WorkEffect>;
  readonly approvals: Readonly<Record<string, ApprovalRecord>>;
  readonly notices: ReadonlyArray<JsonValue>;
  /** What the soft line's push task handed to the push sink. */
  readonly pushes: ReadonlyArray<WorkflowBudgetPush>;
  /** Every node state seen while the run went, by label. */
  readonly seen: ReadonlyMap<string, ReadonlySet<string>>;
  readonly millis: number;
}

const workflow = (body: string) =>
  `export const meta = {\n  name: "budgeted",\n  description: "A budgeted kit workflow",\n  phases: [{ title: "Run" }],\n};\n${body}`;

/** Every `cairn.notice` entry's data in the root thread. */
const noticesOf = async (brain: KitBrain) =>
  await brain.harness.commit(async (tx) => {
    const read = await tx.scanEntries(
      { conversationId: brain.root, order: "ascending" },
      1000
    );

    return read.items.flatMap((entry) =>
      entry.kind === NOTICE_ENTRY_KIND ? [entry.data ?? null] : []
    );
  }, context);

/** Accepts each pending `approve` record, and each raise when `raise` is set. */
const answer = async (brain: KitBrain, raise: boolean) => {
  await brain.harness.commit(async (tx) => {
    const approvals = await tx.doc(Approvals, brain.root);
    const records = Object.values(approvals.items);

    // With `raise`, the script's question waits for the raise, as a user would answer them.
    const raised = records.some(
      (record) => record.tool === RAISE_TOOL && record.status === "accepted"
    );

    for (const record of records) {
      const due =
        record.status === "pending" &&
        ((record.tool === "approve" && (!raise || raised)) ||
          (raise && record.tool === RAISE_TOOL));

      if (due) {
        record.status = "accepted";
        record.answeredAt = DateTime.toEpochMillis(DateTime.nowUnsafe());
        record.decidedBy = { kind: "user" };
        record.answer = {
          decision: "accept",
          answers: null,
          note: null,
          launch: null,
        };
      }
    }
  }, context);
};

/** Plants `body` with `budget`, runs it with the budget reactor, and reads it all back. */
const run = (
  body: string,
  budget: Budget,
  options: { readonly raise?: boolean } = {}
) =>
  Effect.gen(function* () {
    const effects: Array<WorkEffect> = [];
    const pushes: Array<WorkflowBudgetPush> = [];

    const parts = yield* kitParts({
      faults: NO_WORKFLOW_FAULTS,
      hold: async () => {},
      effect: (line) => {
        effects.push(line);
      },
      tokensPerSecond: 50_000,
      push: async (each) => {
        pushes.push(each);
        await Promise.resolve();
      },
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

    const source = workflow(body);

    yield* plant(brain, source, { ...plantDefaults(WF), budget }, context);

    return yield* Effect.promise(async () => {
      const stop = await driveReactors(brain, [workflowBudgetReactor], context);
      const seen = new Map<string, Set<string>>();
      const started = performance.now();

      await runScript(brain, source, "run-1", context);

      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const ledger = await brain.harness.snapshot(
          WorkflowsDoc,
          brain.root,
          context
        );

        const row = ledger?.items[WF];

        for (const node of Object.values(row?.nodes ?? {})) {
          const states = seen.get(node.label) ?? new Set<string>();

          states.add(node.state);
          seen.set(node.label, states);
        }

        if (row !== undefined && isWorkflowEnded(row.state)) {
          break;
        }

        // oxlint-disable-next-line no-await-in-loop
        await answer(brain, options.raise ?? false);
        // oxlint-disable-next-line no-await-in-loop
        await pause(10);
      }

      const millis = performance.now() - started;

      await brain.harness.waitForIdle(context);
      // The stopper and the reactor are background work: let them finish.
      await pause(400);
      await stop();

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

      const row = ledger?.items[WF];

      if (row === undefined) {
        throw new Error("the workflow's row is gone from the ledger");
      }

      const outcome: Outcome = {
        row,
        result: await codemodeResultText(brain, context),
        events: await eventsOf(brain, context),
        effects,
        approvals: approvals?.items ?? {},
        notices: await noticesOf(brain),
        pushes,
        seen,
        millis,
      };

      return outcome;
    });
  }).pipe(Effect.scoped, Effect.provide(KitLayer));

const named = (events: ReadonlyArray<KitEvent>, name: string) =>
  events.filter((event) => event.name === name).length;

const noticeReasons = (notices: ReadonlyArray<JsonValue>) =>
  notices.flatMap((data) =>
    Predicate.isObject(data) &&
    !Array.isArray(data) &&
    Predicate.isString(data.reason)
      ? [data.reason]
      : []
  );

describe("workflow budgets on pi-durable", () => {
  it.live(
    "refuses nodes past the token line, fires each line once and ends partial",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          `const out = [];
for (let i = 0; i < 6; i++) {
  out.push(await agent("node:n" + i + " ms=20${PAD.replaceAll("\n", "\\n")}", { label: "n" + i }));
}
return { out, remaining: await budget.remaining() };`,
          { ...DEFAULT_BUDGET, maxTokens: 4000 }
        );

        const nodes = Object.values(outcome.row.nodes);
        const dispatched = nodes.filter((node) => node.state !== "refused");
        const refused = nodes.filter((node) => node.state === "refused");

        const perNode = Math.min(
          ...dispatched.map((node) => node.receipt?.totalTokens ?? 4000)
        );

        assert.isAtLeast(dispatched.length, 1);
        assert.isAtMost(dispatched.length, Math.ceil(4000 / perNode) + 1);
        assert.isAtLeast(refused.length, 1);
        assert.isTrue(refused.every((node) => node.refusal === "budget_spent"));
        assert.strictEqual(named(outcome.events, "workflow.budget.soft"), 1);
        assert.strictEqual(named(outcome.events, "workflow.budget.spent"), 1);
        assert.strictEqual(outcome.row.state, "finished");
        assert.deepStrictEqual(outcome.row.outcome, {
          kind: "partial",
          reason: "budget_spent",
        });
        assert.include(outcome.result, '"remaining":0');
        assert.strictEqual(
          outcome.row.spent.tokens,
          dispatched.reduce(
            (sum, node) => sum + (node.receipt?.totalTokens ?? 0),
            0
          )
        );
        assert.strictEqual(
          outcome.row.spent.unpricedTokens,
          outcome.row.spent.tokens
        );
        assert.deepStrictEqual(noticeReasons(outcome.notices).toSorted(), [
          "budget_stopped",
          "budget_warning",
        ]);

        // The soft line pushed once, with the warning's words.
        assert.strictEqual(outcome.pushes.length, 1);
        assert.strictEqual(outcome.pushes[0]?.workflowId, WF);
        assert.match(
          outcome.pushes[0]?.text ?? "",
          /^Workflow budgeted has used /u
        );

        // The raise was asked once, and cancelled when the run ended.
        const raise = outcome.approvals[workflowRaiseIdOf(WF, 0)];

        assert.strictEqual(raise?.status, "cancelled");
      })
  );

  it.live(
    "stops running nodes at the line: their rows stopped, the script sees null",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          `const [a, b, c] = await parallel([
  () => agent("node:a ms=4000${PAD.replaceAll("\n", "\\n")}", { label: "a" }),
  () => agent("node:b ms=4000${PAD.replaceAll("\n", "\\n")}", { label: "b" }),
  () => agent("node:c ms=4000${PAD.replaceAll("\n", "\\n")}", { label: "c" }),
]);
return { a, b, c, after: await agent("node:d", { label: "d" }) };`,
          { ...DEFAULT_BUDGET, maxTokens: 1500 }
        );

        const nodes = Object.values(outcome.row.nodes);

        const running = nodes.filter((node) =>
          ["a", "b", "c"].includes(node.label)
        );

        assert.strictEqual(running.length, 3);
        assert.isTrue(running.every((node) => node.state === "stopped"));
        assert.isTrue(running.every((node) => node.error === BUDGET_STOP_TEXT));
        assert.isFalse(outcome.effects.some((line) => line.what === "done"));
        assert.isTrue(outcome.effects.some((line) => line.what === "aborted"));
        assert.strictEqual(
          nodes.find((node) => node.label === "d")?.refusal,
          "budget_spent"
        );
        assert.include(outcome.result, '"a":null');
        assert.deepStrictEqual(outcome.row.outcome, {
          kind: "partial",
          reason: "budget_spent",
        });
        assert.strictEqual(named(outcome.events, "workflow.budget.spent"), 1);
        assert.strictEqual(named(outcome.events, "workflow.node.stopped"), 3);
        assert.isBelow(outcome.millis, 4000);
      })
  );

  it.live(
    "a raise accepted while the run waits lets it start nodes again",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          `const a = await agent("node:a${PAD.replaceAll("\n", "\\n")}", { label: "a" });
const b = await agent("node:b", { label: "b" });
await approve({ summary: "Go on?" });
const c = await agent("node:c", { label: "c" });
return { a, b, c };`,
          // Past what a's first response uses, short of both: a's answer reaches the line.
          { ...DEFAULT_BUDGET, maxTokens: 5000 },
          { raise: true }
        );

        const byLabel = (label: string) =>
          Object.values(outcome.row.nodes).find((node) => node.label === label);

        assert.strictEqual(byLabel("a")?.state, "settled");
        assert.strictEqual(byLabel("b")?.refusal, "budget_spent");
        assert.strictEqual(byLabel("c")?.state, "settled");
        assert.strictEqual(
          outcome.approvals[workflowRaiseIdOf(WF, 0)]?.status,
          "accepted"
        );
      })
  );
});

/** A task as the boot repair inspects it: blocked for `reason`. */
const blockedTask = (id: number, kind: string, reason: string) => ({
  record: { id: taskOf(id), kind },
  state: { kind: "blocked", reason },
});

describe("the boot repair", () => {
  it("retries a parked watcher or stopper, and nothing else", () => {
    const task = blockedTask;

    assert.deepStrictEqual(
      parkedWorkflowTasks([
        task(1, WATCH_TASK, "restart_limit"),
        task(2, STOPPER_TASK, "restart_limit"),
        task(3, STOPPER_TASK, "waiting"),
        task(4, "cairn.subagent-reporter", "restart_limit"),
      ]),
      [taskOf(1), taskOf(2)]
    );
  });
});

describe("usage holds on pi-durable", () => {
  it.live(
    "holds a node on a limit with no reset, then sends its child on",
    () =>
      Effect.gen(function* () {
        const outcome = yield* run(
          `return await agent("node:a limit", { label: "a" });`,
          DEFAULT_BUDGET
        );

        const [node] = Object.values(outcome.row.nodes);

        assert.isTrue(outcome.seen.get("a")?.has("held"));
        assert.strictEqual(node?.state, "settled");
        assert.strictEqual(node?.attempt, 2);
        assert.isNull(node?.held ?? null);
        assert.strictEqual(
          outcome.effects.filter((line) => line.what === "start").length,
          1
        );
        assert.include(outcome.result, '"label":"a"');
        assert.deepStrictEqual(outcome.row.outcome, { kind: "complete" });
        assert.isAtLeast(outcome.millis, 400);
      })
  );

  it.live("goes on at once when the limit's reset has passed", () =>
    Effect.gen(function* () {
      const outcome = yield* run(
        `return await agent("node:a limitreset", { label: "a" });`,
        DEFAULT_BUDGET
      );

      const [node] = Object.values(outcome.row.nodes);

      assert.strictEqual(node?.state, "settled");
      assert.strictEqual(node?.attempt, 2);
      assert.include(CONTINUE_TEXT, "Go on");
    })
  );
});
