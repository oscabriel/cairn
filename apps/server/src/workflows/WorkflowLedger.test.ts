// Ledger conformance (workflows note judge 3, ADR 0032): each rule of the dispatch ledger as one
// scenario, run on a real pi-durable Harness with the code mode, workflows and results extensions
// over the kit's faux model (WorkflowTestKit.ts). Every scenario also runs the ledger check: no
// dispatched row without a brief naming an accepted approval, one child conversation per dispatched
// row, and a node's tool result never carrying usage.

import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { WorkflowsDocument } from "@cairn/protocol/Workflows";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { Approvals, ThreadMeta, ThreadReceipt } from "../brain/CairnDocs.ts";
import { ChildDoc } from "../subagents/SubagentDocs.ts";
import { PRELUDE_VERSION, rewriteScript } from "./Prelude.ts";
import { ledgerProblems, WorkflowsDoc } from "./WorkflowDocs.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowDocs.ts";
import { parseWorkflowScript, scriptHash } from "./WorkflowScript.ts";
import {
  codemodeResultText,
  KIT_CWD,
  kitParts,
  KitLayer,
  openKit,
  pause,
  plant,
  plantDefaults,
  runScript,
  UNRESOLVABLE_ROLE,
} from "./WorkflowTestKit.ts";
import type { KitBrain, PlantInput, WorkEffect } from "./WorkflowTestKit.ts";
import { NO_WORKFLOW_FAULTS } from "./WorkflowTools.ts";
import type { WorkflowFaultSet } from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

const isWorkflowsDocument = Schema.is(WorkflowsDocument);

const WF = "wf-1";

/** What one scenario leaves behind. */
interface Outcome {
  readonly result: string;
  readonly ledger: WorkflowsState;
  readonly row: Option.Option<WorkflowItemState>;
  readonly effects: ReadonlyArray<WorkEffect>;
  /** Conversations a node created, by the node id their `cairn.child` link names. */
  readonly children: ReadonlyMap<string, number>;
  /** Each node child's thread identity and cwd, by node id. */
  readonly identities: ReadonlyMap<string, Identity>;
  /** The summaries of the thread's `approve` records. */
  readonly approveSummaries: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

/** A node child's thread identity: its meta's thread id, whether its receipt names it, its cwd. */
interface Identity {
  readonly threadId: string;
  readonly receipted: boolean;
  readonly cwd: string | null;
}

/** Waits until the workflow row has ended (its watcher wrote it), at most `ms`. */
const settledRow = async (
  brain: KitBrain,
  ms: number
): Promise<Readonly<WorkflowsState> | undefined> => {
  const until = performance.now() + ms;
  let ledger = await brain.harness.snapshot(WorkflowsDoc, brain.root, context);

  while (performance.now() < until) {
    const row = ledger?.items[WF];

    if (
      row === undefined ||
      ["finished", "failed", "stopped", "approved", "declined"].includes(
        row.state
      )
    ) {
      return ledger;
    }

    // oxlint-disable-next-line no-await-in-loop
    await pause(20);
    // oxlint-disable-next-line no-await-in-loop
    ledger = await brain.harness.snapshot(WorkflowsDoc, brain.root, context);
  }

  return ledger;
};

/** Every conversation a node created, by its link's node id. */
const childrenOf = async (brain: KitBrain): Promise<Map<string, number>> =>
  await brain.harness.commit(async (tx) => {
    const found = new Map<string, number>();
    const page = await tx.scanConversations({}, 500);

    for (const conversation of page.items) {
      if (conversation.id === brain.root) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop
      const link = await tx.doc(ChildDoc, conversation.id);

      if (link.parentConversationId === brain.root) {
        found.set(link.key, (found.get(link.key) ?? 0) + 1);
      }
    }

    return found;
  }, context);

/** Each node child's thread identity and cwd, by its link's node id. */
const identitiesOf = async (brain: KitBrain): Promise<Map<string, Identity>> =>
  await brain.harness.commit(async (tx) => {
    const found = new Map<string, Identity>();
    const page = await tx.scanConversations({}, 500);

    for (const conversation of page.items) {
      if (conversation.id === brain.root) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop
      const link = await tx.doc(ChildDoc, conversation.id);

      if (link.parentConversationId !== brain.root) {
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop
      const meta = await tx.doc(ThreadMeta, conversation.id);
      // oxlint-disable-next-line no-await-in-loop
      const agent = await tx.doc(AgentDoc, conversation.id);

      const receipt =
        meta.threadId === ""
          ? undefined
          : // oxlint-disable-next-line no-await-in-loop
            await tx.doc(ThreadReceipt, meta.threadId, { conversationId: 0 });

      found.set(link.key, {
        threadId: meta.threadId,
        receipted: receipt?.conversationId === conversation.id,
        cwd: agent.cwd ?? null,
      });
    }

    return found;
  }, context);

/** Plants `source` (unless `planted` is none), runs `run` on the root thread, and reads it all back. */
const scenario = (
  source: string,
  options: {
    readonly planted?: Option.Option<Partial<PlantInput>>;
    readonly run?: string;
    readonly faults?: WorkflowFaultSet;
    /** Answers every pending `approve` record so, once it appears. */
    readonly answer?: "accepted" | "declined";
  } = {}
) =>
  Effect.gen(function* () {
    const effects: Array<WorkEffect> = [];

    const parts = yield* kitParts({
      faults: options.faults ?? NO_WORKFLOW_FAULTS,
      hold: async () => {},
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

    const planted = options.planted ?? Option.some({});

    if (Option.isSome(planted)) {
      yield* plant(
        brain,
        source,
        { ...plantDefaults(WF), ...planted.value },
        context
      );
    }

    return yield* Effect.promise(async () => {
      const answerer = { running: options.answer !== undefined };

      const answering = (async () => {
        while (answerer.running) {
          // oxlint-disable-next-line no-await-in-loop
          await brain.harness.commit(async (tx) => {
            const approvals = await tx.doc(Approvals, brain.root);

            for (const record of Object.values(approvals.items)) {
              if (record.tool === "approve" && record.status === "pending") {
                record.status = options.answer ?? "declined";
                record.answeredAt = 2;
                record.decidedBy = { kind: "user" };
                record.answer = {
                  decision:
                    options.answer === "accepted" ? "accept" : "decline",
                  answers: null,
                  note: null,
                  launch: null,
                };
              }
            }
          }, context);
          // oxlint-disable-next-line no-await-in-loop
          await pause(20);
        }
      })();

      await runScript(brain, options.run ?? source, "run-1", context);
      await brain.harness.waitForIdle(context);
      answerer.running = false;
      await answering;

      const ledger: Readonly<WorkflowsState> = (await settledRow(
        brain,
        5000
      )) ?? {
        items: {},
      };

      const approvals = await brain.harness.snapshot(
        Approvals,
        brain.root,
        context
      );

      const children = await childrenOf(brain);

      const decodes = isWorkflowsDocument(ledger)
        ? []
        : ["the ledger does not decode as the protocol's WorkflowsDocument"];

      const problems = [
        ...decodes,
        ...ledgerProblems(ledger, approvals?.items ?? {}).map(
          (problem) => `${problem.nodeId}: ${problem.problem}`
        ),
        ...Object.values(ledger.items).flatMap((row) =>
          Object.values(row.nodes).flatMap((node) => {
            const made = children.get(node.id) ?? 0;
            const want = node.state === "refused" ? 0 : 1;

            return made === want
              ? []
              : [
                  `${node.id}: ${String(made)} child conversations, want ${String(want)}`,
                ];
          })
        ),
      ];

      return {
        result: await codemodeResultText(brain, context),
        ledger,
        row: Option.fromUndefinedOr(ledger.items[WF]),
        effects,
        children,
        identities: await identitiesOf(brain),
        approveSummaries: Object.values(approvals?.items ?? {}).flatMap(
          (record) => (record.tool === "approve" ? [record.summary] : [])
        ),
        problems,
      } satisfies Outcome;
    });
  }).pipe(Effect.scoped, Effect.provide(KitLayer));

const workflow = (body: string, name = "kit-flow") =>
  `export const meta = {\n  name: "${name}",\n  description: "A kit workflow",\n  phases: [{ title: "Fan" }],\n};\n${body}`;

const starts = (effects: ReadonlyArray<WorkEffect>) =>
  effects
    .flatMap((line) => (line.what === "start" ? [line.node] : []))
    .toSorted();

describe("ledger conformance on pi-durable", () => {
  it.live(
    "runs an approved workflow's nodes once each and settles every row",
    () =>
      Effect.gen(function* () {
        const outcome = yield* scenario(
          workflow(`phase("Fan");
const [a, b] = await parallel([
  () => agent("node:a", { label: "a" }),
  () => agent("node:b typed", { label: "b", schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } }),
]);
const c = await agent("node:c", { label: "c" });
return { a, b, c };`)
        );

        assert.deepStrictEqual(outcome.problems, []);
        assert.deepStrictEqual(starts(outcome.effects), ["a", "b", "c"]);

        const row = Option.getOrThrow(outcome.row);

        assert.strictEqual(row.state, "finished");
        assert.deepStrictEqual(row.outcome, { kind: "complete" });

        const nodes = Object.values(row.nodes);

        assert.strictEqual(nodes.length, 3);
        assert.isTrue(nodes.every((node) => node.state === "settled"));
        assert.isTrue(
          nodes.every((node) => (node.receipt?.totalTokens ?? 0) > 0)
        );
        assert.include(outcome.result, '"label":"b"');
        assert.strictEqual(
          nodes.find((node) => node.label === "b")?.stage,
          "validated"
        );
      })
  );

  it.live(
    "blocks a workflow script with no approved launch, and dispatches nothing",
    () =>
      Effect.gen(function* () {
        const outcome = yield* scenario(
          workflow(`return await agent("node:a", { label: "a" });`),
          { planted: Option.none() }
        );

        assert.include(outcome.result, "has no approved launch");
        assert.deepStrictEqual(Object.keys(outcome.ledger.items), []);
        assert.deepStrictEqual(outcome.effects, []);
        assert.strictEqual(outcome.children.size, 0);
      })
  );

  it.live("blocks a script changed after Go: the hash binds the launch", () =>
    Effect.gen(function* () {
      const source = workflow(`return await agent("node:a", { label: "a" });`);

      const outcome = yield* scenario(source, {
        run: `${source}\n// one more line`,
      });

      assert.include(outcome.result, "has no approved launch");
      assert.strictEqual(Option.getOrThrow(outcome.row).state, "approved");
      assert.deepStrictEqual(outcome.effects, []);
    })
  );

  it.live(
    "refuses a forged workflow_begin from a script the model wrote itself",
    () =>
      Effect.gen(function* () {
        const source = workflow(
          `return await agent("node:a", { label: "a" });`
        );

        const hash = scriptHash(source);

        const outcome = yield* scenario(source, {
          run: `return await tools.workflow_begin({ workflowId: "${WF}", scriptHash: "${hash}", preludeVersion: ${String(PRELUDE_VERSION)} });`,
        });

        assert.include(outcome.result, "workflow_begin refused");
        assert.strictEqual(Option.getOrThrow(outcome.row).state, "approved");
        assert.deepStrictEqual(outcome.effects, []);
      })
  );

  it.live(
    "refuses a pasted prelude: no gate mark, so workflow_begin refuses it",
    () =>
      Effect.gen(function* () {
        const source = workflow(
          `return await agent("node:a", { label: "a" });`
        );

        const script = yield* parseWorkflowScript(source);

        const pasted = rewriteScript(script, {
          workflowId: WF,
          sample: Option.none(),
          budgetTokens: Option.none(),
          args: {},
        });

        const outcome = yield* scenario(source, { run: pasted });

        assert.include(outcome.result, "workflow_begin refused");
        assert.strictEqual(Option.getOrThrow(outcome.row).state, "approved");
        assert.deepStrictEqual(outcome.effects, []);
      })
  );

  it.live("blocks a model-written script calling tools.agent", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`return await agent("node:a", { label: "a" });`),
        {
          run: `return await tools.agent({ workflowId: "${WF}", prompt: "node:a", site: null, label: "a", phase: null, role: null, schema: null, key: null, readonly: false, resume: null, effort: null, unknownOptions: [] });`,
        }
      );

      assert.include(outcome.result, "agent refused");
      assert.deepStrictEqual(
        Object.keys(Option.getOrThrow(outcome.row).nodes),
        []
      );
      assert.deepStrictEqual(outcome.effects, []);
      assert.strictEqual(outcome.children.size, 0);
    })
  );

  it.live("refuses a launch whose approval is not accepted", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`return await agent("node:a", { label: "a" });`),
        { planted: Option.some({ status: "declined" }) }
      );

      assert.include(outcome.result, "not accepted");
      assert.deepStrictEqual(outcome.effects, []);
    })
  );

  it.live(
    "refuses a node outside the envelope; the script sees null and goes on",
    () =>
      Effect.gen(function* () {
        const outcome = yield* scenario(
          workflow(`const a = await agent("node:a", { label: "a", role: "@scout" });
const b = await agent("node:b", { label: "b" });
return { a, b };`),
          {
            planted: Option.some({
              envelope: (granted) => ({
                ...granted,
                roles: granted.roles.filter((role) => role.spec !== "@scout"),
              }),
            }),
          }
        );

        assert.deepStrictEqual(outcome.problems, []);

        const nodes = Object.values(Option.getOrThrow(outcome.row).nodes);

        assert.deepStrictEqual(
          nodes.map((node) => [node.label, node.state, node.refusal]),
          [
            ["a", "refused", "outside_grant"],
            ["b", "settled", null],
          ]
        );
        assert.include(outcome.result, '"a":null');
        assert.deepStrictEqual(starts(outcome.effects), ["b"]);
      })
  );

  it.live(
    "refuses a writer where the envelope granted a reader of that role",
    () =>
      Effect.gen(function* () {
        const outcome = yield* scenario(
          workflow(
            `return await agent("node:a", { label: "a", role: "@scout" });`
          ),
          {
            planted: Option.some({
              envelope: (granted) => ({
                ...granted,
                roles: granted.roles.map((role) => ({
                  ...role,
                  readonly: true,
                })),
              }),
            }),
          }
        );

        const [node] = Object.values(Option.getOrThrow(outcome.row).nodes);

        assert.strictEqual(node?.refusal, "outside_grant");
        assert.deepStrictEqual(outcome.effects, []);
      })
  );

  it.live("refuses a node past the envelope's cap", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`const a = await agent("node:a", { label: "a" });
const b = await agent("node:b", { label: "b" });
return { a, b };`),
        { planted: Option.some({ maxNodes: Option.some(1) }) }
      );

      assert.deepStrictEqual(outcome.problems, []);

      assert.deepStrictEqual(
        Object.values(Option.getOrThrow(outcome.row).nodes).map((node) => [
          node.label,
          node.state,
          node.refusal,
        ]),
        [
          ["a", "settled", null],
          ["b", "refused", "node_cap"],
        ]
      );
      assert.deepStrictEqual(starts(outcome.effects), ["a"]);
    })
  );

  it.live("refuses a node whose role resolves to no model", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(
          `return await agent.full("node:a", { label: "a", role: "${UNRESOLVABLE_ROLE}" });`
        )
      );

      const [node] = Object.values(Option.getOrThrow(outcome.row).nodes);

      assert.strictEqual(node?.refusal, "no_provider");
      assert.include(outcome.result, "no model is bound");
      assert.deepStrictEqual(outcome.effects, []);
    })
  );

  it.live("nudges a typed child once, then takes its result", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(
          `return await agent("node:a lazy", { label: "a", schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } });`
        )
      );

      const [node] = Object.values(Option.getOrThrow(outcome.row).nodes);

      assert.strictEqual(node?.state, "settled");
      assert.deepStrictEqual(node?.result, { label: "a" });
      assert.include(outcome.result, '"label":"a"');
    })
  );

  it.live("fails a typed node whose child never submits a valid result", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(
          `const a = await agent.full("node:a bad", { label: "a", schema: { type: "object", properties: { label: { type: "string" } }, required: ["label"] } });
return a.status;`
        )
      );

      const [node] = Object.values(Option.getOrThrow(outcome.row).nodes);

      assert.strictEqual(node?.state, "failed");
      assert.include(node?.error ?? "", "invalid_result");
      assert.include(outcome.result, "failed");
      assert.deepStrictEqual(outcome.problems, []);
    })
  );

  it.live("fails a node whose child's run fails; the script sees null", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`const a = await agent("node:a fail", { label: "a" });
return { a, after: true };`)
      );

      const row = Option.getOrThrow(outcome.row);
      const [node] = Object.values(row.nodes);

      assert.strictEqual(node?.state, "failed");
      assert.strictEqual(row.state, "finished");
      assert.include(outcome.result, '"a":null');
    })
  );

  it.live("records phases that appear at run time and log lines by task", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`phase("Fan");
log("one");
phase("Later");
log("two");
return await agent("node:a", { label: "a" });`)
      );

      const row = Option.getOrThrow(outcome.row);

      assert.deepStrictEqual(
        row.phases.map((phase) => phase.title),
        ["Fan", "Later"]
      );
      assert.deepStrictEqual(
        Object.values(row.log).map((line) => line.text),
        ["one", "two"]
      );
      assert.strictEqual(Object.values(row.nodes)[0]?.phase, "Later");
    })
  );

  it.live("answers budget readings from the settled receipts", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`const before = await budget.spent();
await agent("node:a", { label: "a" });
return { before, after: await budget.spent(), remaining: await budget.remaining(), total: budget.total };`),
        {
          planted: Option.some({
            budget: { ...DEFAULT_BUDGET, maxTokens: 1_000_000 },
          }),
        }
      );

      const row = Option.getOrThrow(outcome.row);
      const used = Object.values(row.nodes)[0]?.receipt?.totalTokens ?? 0;

      assert.isAbove(used, 0);
      assert.include(outcome.result, '"before":0');
      assert.include(outcome.result, `"after":${String(used)}`);
      assert.include(outcome.result, `"remaining":${String(1_000_000 - used)}`);
      assert.include(outcome.result, '"total":1000000');
      assert.strictEqual(row.spent.tokens, used);
    })
  );

  it.live("asks the user with approve() and resolves with the answer", () =>
    Effect.gen(function* () {
      const body = `const ok = await approve({ summary: "Go on?" });
if (!ok.accepted) return "stopped by the user";
return await agent("node:a", { label: "a" });`;

      const accepted = yield* scenario(workflow(body), { answer: "accepted" });
      const declined = yield* scenario(workflow(body), { answer: "declined" });

      assert.deepStrictEqual(starts(accepted.effects), ["a"]);
      assert.deepStrictEqual(declined.effects, []);
      assert.include(declined.result, "stopped by the user");
    })
  );

  it.live("verifies a result in a fresh child and marks the row verified", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`const found = await agent("node:a", { label: "a" });
return await verify(found, { claim: "a is fine" });`)
      );

      const nodes = Object.values(Option.getOrThrow(outcome.row).nodes);

      assert.deepStrictEqual(
        nodes.map((node) => [node.role, node.readonly, node.stage]),
        [
          ["@worker", false, "answered"],
          ["@verifier", true, "verified"],
        ]
      );
      assert.include(outcome.result, '"verdict":"verified"');
      assert.deepStrictEqual(outcome.problems, []);
    })
  );

  it.live("ends a workflow whose script throws as failed, script_error", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`const a = await agent("node:a", { label: "a" });
if (a !== null && a.includes("label")) throw new Error("the script gave up");
return a;`)
      );

      const row = Option.getOrThrow(outcome.row);

      assert.strictEqual(row.state, "failed");
      assert.deepStrictEqual(row.outcome, {
        kind: "partial",
        reason: "script_error",
      });
      assert.isNotNull(row.result);
    })
  );

  it.live(
    "gives each node's child a thread identity and the launching thread's cwd",
    () =>
      Effect.gen(function* () {
        const outcome = yield* scenario(
          workflow(`return await agent("node:a", { label: "a" });`)
        );

        assert.deepStrictEqual(outcome.problems, []);

        const [node] = Object.values(Option.getOrThrow(outcome.row).nodes);
        const identity = outcome.identities.get(node?.id ?? "");

        assert.isNotNull(node?.childThreadId ?? null);
        assert.strictEqual(identity?.threadId, node?.childThreadId);
        assert.isTrue(identity?.receipted);
        assert.strictEqual(identity?.cwd, KIT_CWD);
        assert.isNotNull(node?.submissionId ?? null);
      })
  );

  it.live(
    "keeps the ledger decoding when a script passes a bad role, empty key or long label",
    () =>
      Effect.gen(function* () {
        const long = "L".repeat(5000);

        const outcome = yield* scenario(
          // The dry run refuses these values, so the script passes them only when it runs live (a
          // node's real answer is not the dry run's placeholder): what a script can always do.
          workflow(`const x = await agent("node:x", { label: "x" });
const live = !String(x).startsWith("(dry run");
const a = await agent("node:a", { label: "a", role: live ? "reader" : "@worker" });
const b = await agent("node:b", live ? { label: "${long}", key: "  ", effort: "", phase: "   " } : { label: "b" });
const c = await agent("node:c", live ? { label: "c", effort: "loud" } : { label: "c" });
return { a, b, c };`)
        );

        // The ledger still decodes as the protocol's document (the scenario's first check).
        assert.deepStrictEqual(outcome.problems, []);

        const nodes = Object.values(Option.getOrThrow(outcome.row).nodes);

        // A bad role or effort writes no row; the script sees null and goes on.
        assert.strictEqual(nodes.length, 2);

        const b = nodes.find((node) => node.label.startsWith("L"));

        assert.strictEqual(b?.state, "settled");
        assert.isAtMost(b?.label.length ?? 0, 200);
        assert.isNull(b?.key ?? null);
        assert.isNull(b?.effort ?? null);
        assert.isNull(b?.phase ?? null);
        assert.include(outcome.result, '"a":null');
        assert.include(outcome.result, '"c":null');
        assert.deepStrictEqual(starts(outcome.effects), ["b", "x"]);
      })
  );

  it.live("cuts an approve() summary and refuses more than nine options", () =>
    Effect.gen(function* () {
      const long = "S".repeat(5000);

      const ten = JSON.stringify(
        Array.from({ length: 10 }, (_, index) => `option ${String(index)}`)
      );

      const outcome = yield* scenario(
        workflow(`await agent("node:a", { label: "a" });
const many = await approve({ summary: "Pick", options: ${ten} });
const ok = await approve({ summary: "${long}" });
return { many, accepted: ok === null ? null : ok.accepted };`),
        { answer: "accepted" }
      );

      assert.include(outcome.result, '"many":null');
      assert.include(outcome.result, '"accepted":true');
      assert.strictEqual(outcome.approveSummaries.length, 1);
      assert.isAtMost(outcome.approveSummaries[0]?.length ?? 0, 4096);
    })
  );

  it.live("never puts usage in a node's result to the script", () =>
    Effect.gen(function* () {
      const outcome = yield* scenario(
        workflow(`return await agent.full("node:a", { label: "a" });`)
      );

      assert.include(outcome.result, '"status":"ok"');
      assert.notInclude(outcome.result, "usage");
      assert.notInclude(outcome.result, "totalTokens");
    })
  );
});
