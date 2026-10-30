// A workflow's launch approval end to end on pi-durable (ADR 0032, workflows note W4, briefs note
// B8): the kit's model proposes its script with `workflow_plan`, the user answers the launch card
// through the host's answer path (`answerApproval` with `launchAnswered`, as `thread.respond`
// does), and on Go the model runs the same script with `codemode`. The scenario
// `workflow_node_within_envelope` is this package's: five nodes, of which four fit the envelope
// the launch granted (accepted with `decidedBy` envelope) and one raises its own brief card.
//
// The scripted harness does not model workflows (4D's ledger conformance runs on pi-durable only),
// so these scenarios run here, on the real Harness, rather than in the seam's NDJSON suite.

import { ConversationId } from "@cairn/protocol/Ids";
import { WorkflowLaunch } from "@cairn/protocol/Policy";
import type { ApprovalDecision, LaunchEdits } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { answerApproval, Approvals } from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { EventsDoc, eventKind } from "../brain/Events.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { ledgerProblems, WorkflowsDoc } from "./WorkflowDocs.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowDocs.ts";
import { isNodeBrief, LAUNCH_TOOL, launchAnswered } from "./WorkflowLaunch.ts";
import {
  kitParts,
  KitLayer,
  openKit,
  pause,
  PLAN_PREFIX,
} from "./WorkflowTestKit.ts";
import type { KitBrain, WorkEffect } from "./WorkflowTestKit.ts";
import { NO_WORKFLOW_FAULTS } from "./WorkflowTools.ts";
import type { WorkflowFaultSet } from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

/** When the user answers, on the record: any fixed time, as the kit plants its records. */
const ANSWERED_AT = 2;

const decodeLaunch = Schema.decodeUnknownSync(WorkflowLaunch);

/** How the user answers one launch card. */
interface LaunchAnswer {
  readonly decision: ApprovalDecision;
  readonly edits: Option.Option<LaunchEdits>;
}

/** What one flow leaves behind. */
interface Flow {
  readonly reply: string;
  readonly ledger: Readonly<WorkflowsState>;
  readonly rows: ReadonlyArray<WorkflowItemState>;
  readonly records: Readonly<Record<string, ApprovalRecord>>;
  readonly effects: ReadonlyArray<WorkEffect>;
  /** Node brief cards that were pending at some point, by id. */
  readonly cards: ReadonlySet<string>;
  /** Event names in the log, in order. */
  readonly events: ReadonlyArray<string>;
  readonly problems: ReadonlyArray<string>;
}

/** Answers one record from the host side, as `thread.respond` does. */
const answer = async (
  brain: KitBrain,
  record: ApprovalRecord,
  decision: ApprovalDecision,
  edits: Option.Option<LaunchEdits>
): Promise<void> => {
  await Effect.runPromise(
    answerApproval(
      brain.harness,
      brain.root,
      record.id,
      {
        decision,
        by: { kind: "user" },
        reason:
          decision === "decline" ? Option.some("not this one") : Option.none(),
        answers: Option.none(),
        launch: edits,
      },
      ANSWERED_AT,
      launchAnswered
    )
  );
};

/** The names of the events in the log, oldest first. */
const eventsOf = async (brain: KitBrain): Promise<ReadonlyArray<string>> => {
  const state = await brain.harness.snapshot(EventsDoc, context);

  if (state?.logConversationId === null || state === undefined) {
    return [];
  }

  const log = state.logConversationId;

  return await brain.harness.commit(async (tx) => {
    const page = await tx.scanEntries(
      {
        conversationId: piConversationId(ConversationId.make(log)),
        order: "ascending",
      },
      500
    );

    return page.items.map((entry) => entry.kind);
  }, context);
};

/**
 * The kit's model proposes `script`; each launch card is answered by the next of `launches`, and
 * every node's own card with `briefs`. Reads it all back once the thread is idle.
 */
const flow = (
  script: string,
  options: {
    readonly launches: ReadonlyArray<LaunchAnswer>;
    readonly briefs?: "accept" | "decline";
    readonly faults?: WorkflowFaultSet;
  }
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

    return yield* Effect.promise(async (): Promise<Flow> => {
      const cards = new Set<string>();
      const answered = new Set<string>();
      const answering = { running: true, launches: 0 };

      const answerer = (async () => {
        while (answering.running) {
          // oxlint-disable-next-line no-await-in-loop
          const approvals = await brain.harness.snapshot(
            Approvals,
            brain.root,
            context
          );

          const pending = Object.values(approvals?.items ?? {}).filter(
            (record) => record.status === "pending" && !answered.has(record.id)
          );

          for (const record of pending) {
            if (record.tool === LAUNCH_TOOL) {
              const next = options.launches[answering.launches];

              if (next !== undefined) {
                answering.launches += 1;
                answered.add(record.id);
                // oxlint-disable-next-line no-await-in-loop -- one answer at a time
                await answer(brain, record, next.decision, next.edits);
              }
            } else if (isNodeBrief(record) && options.briefs !== undefined) {
              cards.add(record.id);
              answered.add(record.id);
              // oxlint-disable-next-line no-await-in-loop -- one answer at a time
              await answer(brain, record, options.briefs, Option.none());
            } else if (isNodeBrief(record)) {
              cards.add(record.id);
            }
          }

          // oxlint-disable-next-line no-await-in-loop
          await pause(20);
        }
      })();

      const root = await brain.harness.conversation(brain.root, context);

      await root?.submit(
        {
          type: "input",
          content: `${PLAN_PREFIX}${script}`,
          requestId: "plan-1",
        },
        context
      );
      await brain.harness.waitForIdle(context);
      answering.running = false;
      await answerer;

      // The watchers record each script call's end in their own commits.
      await pause(300);

      const ledger: Readonly<WorkflowsState> = (await brain.harness.snapshot(
        WorkflowsDoc,
        brain.root,
        context
      )) ?? { items: {} };

      const approvals = await brain.harness.snapshot(
        Approvals,
        brain.root,
        context
      );

      const view = await root?.context(context);
      const last = view?.messages.at(-1);

      return {
        reply:
          last?.role === "assistant"
            ? last.content
                .map((part) => (part.type === "text" ? part.text : ""))
                .join("")
            : "",
        ledger,
        rows: Object.values(ledger.items),
        records: approvals?.items ?? {},
        effects,
        cards,
        events: await eventsOf(brain),
        problems: ledgerProblems(ledger, approvals?.items ?? {}).map(
          (problem) => `${problem.nodeId}: ${problem.problem}`
        ),
      };
    });
  }).pipe(Effect.scoped, Effect.provide(KitLayer));

const workflow = (body: string, name = "kit-flow") =>
  `export const meta = {\n  name: "${name}",\n  description: "A kit workflow",\n  phases: [{ title: "Fan" }],\n};\n${body}`;

const GO: LaunchAnswer = { decision: "accept", edits: Option.none() };

const starts = (effects: ReadonlyArray<WorkEffect>) =>
  effects
    .flatMap((line) => (line.what === "start" ? [line.node] : []))
    .toSorted();

/**
 * Five nodes: four `@worker` nodes in a fan-out, then a fifth whose role the data decides. The dry
 * run's placeholder answers send it to `@worker`, so the plan shows one role and five nodes; the
 * live answers send it to `@scout`, which the envelope never granted.
 */
const FIVE = workflow(`phase("Fan");
const found = await parallel(["a", "b", "c", "d"].map((item) => () => agent("node:" + item, { label: item })));
const live = !String(found[0]).startsWith("(dry run");
const e = await agent("node:e", { label: "e", role: live ? "@scout" : "@worker" });
return { found, e };`);

describe("launch approval and the envelope on pi-durable", () => {
  it.live(
    "workflow_node_within_envelope: four of five node briefs fit the envelope and one raises a card",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, { launches: [GO], briefs: "accept" });

        assert.deepStrictEqual(outcome.problems, []);

        const [row] = outcome.rows;

        assert.strictEqual(row?.state, "finished");

        const launch = outcome.records[row?.approvalId ?? ""];

        assert.strictEqual(launch?.tool, LAUNCH_TOOL);
        assert.strictEqual(launch?.status, "accepted");
        assert.deepStrictEqual(launch?.decidedBy, { kind: "user" });

        // The plan the user said Go to: five nodes, one role, and Go covers five.
        const plan = decodeLaunch(launch?.payload);

        assert.deepStrictEqual(plan.nodes, { count: 5, unbounded: false });
        assert.deepStrictEqual(
          plan.envelope.roles.map((role) => role.spec),
          ["@worker"]
        );
        assert.strictEqual(plan.envelope.maxNodes, 5);

        const nodes = Object.values(row?.nodes ?? {});

        const deciders = nodes.map((node) => [
          node.label,
          outcome.records[node.briefId ?? ""]?.decidedBy?.kind,
        ]);

        assert.deepStrictEqual(deciders, [
          ["a", "envelope"],
          ["b", "envelope"],
          ["c", "envelope"],
          ["d", "envelope"],
          ["e", "user"],
        ]);
        assert.strictEqual(outcome.cards.size, 1, "exactly one card");
        assert.isTrue(nodes.every((node) => node.state === "settled"));
        assert.deepStrictEqual(starts(outcome.effects), [
          "a",
          "b",
          "c",
          "d",
          "e",
        ]);

        const card = outcome.records[nodes[4]?.briefId ?? ""];

        assert.strictEqual(card?.kind, "brief");
        assert.include(
          JSON.stringify(card?.payload),
          "did not show role @scout"
        );

        // Events: the launch's answer, each accepted brief, the card's answer.
        const count = (name: Parameters<typeof eventKind>[0]) =>
          outcome.events.filter((kind) => kind === eventKind(name)).length;

        assert.strictEqual(count("workflow.proposed"), 1);
        assert.strictEqual(count("approval.answered"), 2);
        assert.strictEqual(count("brief.approved"), 6);
        assert.include(outcome.reply, "done");
      }),
    30_000
  );

  it.live(
    "workflow_node_within_envelope, declined: the card's node is refused and the four still run",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, {
          launches: [GO],
          briefs: "decline",
        });

        assert.deepStrictEqual(outcome.problems, []);

        const nodes = Object.values(outcome.rows[0]?.nodes ?? {});

        assert.deepStrictEqual(
          nodes.map((node) => [node.label, node.state, node.refusal]),
          [
            ["a", "settled", null],
            ["b", "settled", null],
            ["c", "settled", null],
            ["d", "settled", null],
            ["e", "refused", "outside_grant"],
          ]
        );
        assert.deepStrictEqual(starts(outcome.effects), ["a", "b", "c", "d"]);
        assert.include(outcome.reply, '"e":null');
      }),
    30_000
  );

  it.live(
    "a broken envelope that grants every node raises no card (the judge's control)",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, {
          launches: [GO],
          briefs: "decline",
          faults: { ...NO_WORKFLOW_FAULTS, grantAll: true },
        });

        assert.strictEqual(outcome.cards.size, 0);
        assert.deepStrictEqual(starts(outcome.effects), [
          "a",
          "b",
          "c",
          "d",
          "e",
        ]);
      }),
    30_000
  );

  it.live(
    "Decline on the launch runs nothing and declines the row",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, {
          launches: [{ decision: "decline", edits: Option.none() }],
        });

        const [row] = outcome.rows;

        assert.strictEqual(row?.state, "declined");
        assert.deepStrictEqual(row?.nodes, {});
        assert.deepStrictEqual(outcome.effects, []);
        assert.include(
          outcome.reply,
          "declined workflow kit-flow: not this one"
        );
      }),
    30_000
  );

  it.live(
    "Go with the card's edits runs on the edited budget; the frozen payload stays as proposed",
    () =>
      Effect.gen(function* () {
        const edits: LaunchEdits = {
          budget: { ...DEFAULT_BUDGET, maxTokens: 900_000 },
          roleOverrides: {},
        };

        const outcome = yield* flow(
          workflow(`const a = await agent("node:a", { label: "a" });
return { a, total: budget.total };`),
          { launches: [{ decision: "accept", edits: Option.some(edits) }] }
        );

        const [row] = outcome.rows;
        const launch = outcome.records[row?.approvalId ?? ""];

        assert.strictEqual(row?.budget.maxTokens, 900_000);
        assert.isNull(decodeLaunch(launch?.payload).envelope.budget.maxTokens);
        assert.deepStrictEqual(launch?.answer?.launch, {
          budget: { ...DEFAULT_BUDGET, maxTokens: 900_000 },
          roleOverrides: {},
        });
        assert.include(outcome.reply, '"total":900000');
      }),
    30_000
  );

  it.live(
    "Run on 1 first is a separate run of one item; the launch on all runs every item again",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(
          workflow(
            `return await pipeline(["a", "b", "c"], (item) => agent("node:" + item, { label: item }));`
          ),
          {
            launches: [{ decision: "accept_sample", edits: Option.none() }, GO],
          }
        );

        assert.deepStrictEqual(outcome.problems, []);

        const [sample, all] = outcome.rows;

        assert.strictEqual(sample?.sample, 1);
        assert.strictEqual(sample?.state, "finished");
        assert.deepStrictEqual(
          Object.values(sample?.nodes ?? {}).map((node) => node.label),
          ["a"]
        );
        assert.isNull(all?.sample ?? null);
        assert.deepStrictEqual(
          Object.values(all?.nodes ?? {}).map((node) => node.label),
          ["a", "b", "c"]
        );
        // No cache: item a ran in both launches.
        assert.deepStrictEqual(starts(outcome.effects), ["a", "a", "b", "c"]);
        assert.strictEqual(
          outcome.records[sample?.approvalId ?? ""]?.answer?.decision,
          "accept_sample"
        );
      }),
    45_000
  );

  it.live(
    "a script the dry run refuses never reaches the user",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(workflow(`return 1;`), { launches: [GO] });

        assert.deepStrictEqual(outcome.rows, []);
        assert.deepStrictEqual(Object.keys(outcome.records), []);
        assert.include(outcome.reply, "dispatched no node");
      }),
    30_000
  );
});
