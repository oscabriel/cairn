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
import { Brief, WorkflowLaunch } from "@cairn/protocol/Policy";
import type { ApprovalDecision, LaunchEdits } from "@cairn/protocol/Policy";
import { DEFAULT_BUDGET, Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, MemoryStorage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import {
  answerApproval,
  Approvals,
  cancelStoppedApprovals,
} from "../brain/CairnDocs.ts";
import type { ApprovalRecord } from "../brain/CairnDocs.ts";
import { EventsDoc, eventKind } from "../brain/Events.ts";
import { piConversationId } from "../brain/PiIds.ts";
import { testLimit } from "../EventuallyTestKit.ts";
import {
  ledgerProblems,
  WorkflowSourcesDoc,
  WorkflowsDoc,
} from "./WorkflowDocs.ts";
import type { WorkflowItemState, WorkflowsState } from "./WorkflowDocs.ts";
import { isNodeBrief, LAUNCH_TOOL, launchAnswered } from "./WorkflowLaunch.ts";
import type { WorkflowPlan } from "./WorkflowPlan.ts";
import {
  ALT_MODEL,
  KIT_SPEC,
  kitParts,
  KitLayer,
  openKit,
  pause,
  PLAN_ONLY_PREFIX,
  PLAN_PREFIX,
  PLAN_TWICE_PREFIX,
  PLAN_TWICE_TOGETHER_PREFIX,
  plant,
  plantDefaults,
  TWICE_ARGS,
} from "./WorkflowTestKit.ts";
import type { KitBrain, WorkEffect } from "./WorkflowTestKit.ts";
import { NO_WORKFLOW_FAULTS } from "./WorkflowTools.ts";
import type { WorkflowFaultSet } from "./WorkflowTools.ts";

const context = BACKGROUND_CONTEXT;

/** When the user answers, on the record: any fixed time, as the kit plants its records. */
const ANSWERED_AT = 2;

/** The words a Decline or a Send back carries; the other answers carry none. */
const REASONS: Partial<Record<ApprovalDecision, string>> = {
  decline: "not this one",
  revise: "fewer nodes",
};

const decodeLaunch = Schema.decodeUnknownSync(WorkflowLaunch);

const decodeBrief = Schema.decodeUnknownSync(Brief);

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
        reason: Option.fromUndefinedOr(REASONS[decision]),
        answers: Option.none(),
        launch: edits,
      },
      ANSWERED_AT,
      launchAnswered
    )
  );
};

/** When the stop lands, on the records it cancels. */
const STOPPED_AT = 3;

/**
 * Stops the thread's run as the host's stop does (`abortAndCancel`): aborts the run's task, waits
 * for it to end, then cancels the records it held in one commit.
 */
const stopRun = async (brain: KitBrain): Promise<void> => {
  const live = await brain.harness.snapshot(LiveDoc, brain.root, context);
  const run = live?.run;

  if (run === undefined) {
    return;
  }

  await brain.harness.abortTask(run.taskId, context);
  await brain.harness.waitForTask(run.taskId, context);
  await Effect.runPromise(
    cancelStoppedApprovals(brain.harness, brain.root, [run.taskId], STOPPED_AT)
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
    /** Stops the thread instead of answering the first launch or node card that waits. */
    readonly stopAt?: "launch" | "card";
    /** Project recipes a reference may name, source by name. */
    readonly projectRecipes?: Readonly<Record<string, string>>;
    /** The server's default budget; no limit when absent. */
    readonly defaultBudget?: Budget;
    /** What the thread holds before the model proposes: launches planted on its ledger. */
    readonly before?: (
      brain: KitBrain
    ) => Effect.Effect<void, never, WorkflowPlan>;
    /** How the model proposes: `PLAN_PREFIX` unless a case says otherwise. */
    readonly prefix?: string;
    /**
     * An earlier run on the thread, whose launch cards take the first answers: sent and run to its
     * end before the case's own input, with `between` run between the two (a recipe file edited).
     */
    readonly earlier?: { readonly input: string; readonly between: () => void };
  }
) =>
  Effect.gen(function* () {
    const effects: Array<WorkEffect> = [];

    const parts = yield* kitParts({
      projectRecipes: options.projectRecipes ?? {},
      defaultBudget: options.defaultBudget ?? DEFAULT_BUDGET,
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

    if (options.before !== undefined) {
      yield* options.before(brain);
    }

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

          const waiting = pending.find((record) =>
            options.stopAt === "launch"
              ? record.tool === LAUNCH_TOOL
              : options.stopAt === "card" && isNodeBrief(record)
          );

          if (waiting !== undefined) {
            answered.add(waiting.id);

            if (isNodeBrief(waiting)) {
              cards.add(waiting.id);
            }

            // oxlint-disable-next-line no-await-in-loop -- one stop
            await stopRun(brain);
            answering.running = false;
          }

          for (const record of answering.running ? pending : []) {
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

      if (options.earlier !== undefined) {
        await root?.submit(
          {
            type: "input",
            content: options.earlier.input,
            requestId: "plan-0",
          },
          context
        );
        await brain.harness.waitForIdle(context);
        options.earlier.between();
      }

      await root?.submit(
        {
          type: "input",
          content: `${options.prefix ?? PLAN_PREFIX}${script}`,
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

/** A project recipe launched by reference, as the model proposes and runs it. */
const RECIPE_REFERENCE = `export const meta = { name: "kit-recipe" };`;

/** The recipe's file before an edit, and after it. */
const OLD_RECIPE = workflow(
  `return await agent("node:old", { label: "old" });`,
  "kit-recipe"
);

const NEW_RECIPE = workflow(
  `return await agent("node:new", { label: "new" });`,
  "kit-recipe"
);

/** A recipe whose one node is named by its launch's arguments. */
const ASKING_RECIPE = workflow(
  `return await agent("node:" + args.question, { label: args.question });`,
  "kit-recipe"
);

const starts = (effects: ReadonlyArray<WorkEffect>) =>
  effects
    .flatMap((line) => (line.what === "start" ? [line.node] : []))
    .toSorted();

/**
 * Five nodes: four on the launching thread's model in a fan-out, then a fifth whose model the data
 * decides. The dry run's placeholder answers leave it on the thread's model, so the plan shows one
 * model and five nodes; the live answers send it to `ALT_MODEL`, which the envelope never granted.
 */
const FIVE = workflow(`phase("Fan");
const found = await parallel(["a", "b", "c", "d"].map((item) => () => agent("node:" + item, { label: item })));
const live = !String(found[0]).startsWith("(dry run");
const e = await agent("node:e", { label: "e", model: live ? "${ALT_MODEL}" : undefined });
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

        // The plan the user said Go to: five nodes, one model, and Go covers five.
        const plan = decodeLaunch(launch?.payload);

        assert.deepStrictEqual(plan.nodes, { count: 5, unbounded: false });
        assert.deepStrictEqual(
          plan.envelope.models.map((entry) => entry.spec),
          [KIT_SPEC]
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
          `did not show model ${ALT_MODEL}`
        );

        // Events: the launch's answer, each accepted brief, the card's answer.
        const count = (name: Parameters<typeof eventKind>[0]) =>
          outcome.events.filter((kind) => kind === eventKind(name)).length;

        assert.strictEqual(count("workflow.proposed"), 1);
        assert.strictEqual(count("approval.answered"), 2);
        assert.strictEqual(count("brief.approved"), 6);
        assert.include(outcome.reply, "done");
      }),
    testLimit(30_000)
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
    testLimit(30_000)
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
    testLimit(30_000)
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
    testLimit(30_000)
  );

  it.live(
    "a second Go on a script with an approved launch left over runs the newer launch and supersedes the older",
    () =>
      Effect.gen(function* () {
        // A launch the user said Go to whose run stopped before it called codemode: its record is
        // accepted, so the stop's cancel leaves its row approved.
        const script =
          workflow(`const a = await agent("node:a", { label: "a" });
return { a, args, total: budget.total };`);

        const outcome = yield* flow(script, {
          launches: [GO],
          before: (brain) =>
            plant(
              brain,
              script,
              {
                ...plantDefaults("wf-stale"),
                args: { question: "stale" },
                budget: { ...DEFAULT_BUDGET, maxTokens: 700_000 },
              },
              context
            ).pipe(Effect.orDie, Effect.asVoid),
        });

        const stale = outcome.ledger.items["wf-stale"];
        const fresh = outcome.rows.find((row) => row.id !== "wf-stale");

        assert.deepStrictEqual(outcome.problems, []);
        assert.strictEqual(fresh?.state, "finished", "the newer Go ran");
        assert.strictEqual(stale?.state, "declined", "the older Go ended");
        assert.deepStrictEqual(stale?.decidedBy, {
          kind: "system",
          why: "superseded",
        });
        assert.deepStrictEqual(stale?.nodes, {});
        assert.notInclude(outcome.reply, "stale");
        assert.notInclude(outcome.reply, "700000");
      }),
    testLimit(30_000)
  );

  it.live(
    "a Go whose run ends before codemode ends with it, and a newer Go of the recipe, its file since changed, runs the new file",
    () =>
      Effect.gen(function* () {
        // The first run proposes the project recipe, gets Go and answers without running it; the
        // file is edited; the second run proposes it again, gets Go and runs it.
        const recipes = { "kit-recipe": OLD_RECIPE };

        const outcome = yield* flow(RECIPE_REFERENCE, {
          launches: [GO, GO],
          projectRecipes: recipes,
          earlier: {
            input: `${PLAN_ONLY_PREFIX}${RECIPE_REFERENCE}`,
            between: () => {
              recipes["kit-recipe"] = NEW_RECIPE;
            },
          },
        });

        const [left, newer] = outcome.rows;

        assert.deepStrictEqual(outcome.problems, []);
        assert.strictEqual(newer?.state, "finished", "the newer Go ran");
        assert.deepStrictEqual(starts(outcome.effects), ["new"]);
        assert.strictEqual(left?.state, "declined", "the older Go ended");
        assert.deepStrictEqual(left?.decidedBy, {
          kind: "system",
          why: "run-stopped",
        });
        assert.deepStrictEqual(left?.nodes, {});
      }),
    testLimit(30_000)
  );

  it.live(
    "an approved launch of a recipe left over from an ended run never runs, and the newer Go runs the new file",
    () =>
      Effect.gen(function* () {
        // The leftover row as an earlier run left it, bound to that run, with the old file's
        // source kept beside the ledger.
        const outcome = yield* flow(RECIPE_REFERENCE, {
          launches: [GO],
          projectRecipes: { "kit-recipe": NEW_RECIPE },
          before: (brain) =>
            Effect.gen(function* () {
              yield* plant(
                brain,
                OLD_RECIPE,
                {
                  ...plantDefaults("wf-left"),
                  args: { question: "left over" },
                  run: Option.some(999_999),
                },
                context
              ).pipe(Effect.orDie);

              yield* Effect.promise(async () => {
                await brain.harness.commit(async (tx) => {
                  const sources = await tx.doc(WorkflowSourcesDoc, brain.root);

                  sources.items["wf-left"] = {
                    name: "kit-recipe",
                    source: OLD_RECIPE,
                  };
                }, context);
              });
            }),
        });

        const left = outcome.ledger.items["wf-left"];
        const newer = outcome.rows.find((row) => row.id !== "wf-left");

        assert.deepStrictEqual(outcome.problems, []);
        assert.strictEqual(newer?.state, "finished", "the newer Go ran");
        assert.deepStrictEqual(starts(outcome.effects), ["new"]);
        assert.deepStrictEqual(left?.nodes, {});
        assert.notInclude(outcome.reply, "left over");
      }),
    testLimit(30_000)
  );

  it.live(
    "two Goes on one recipe with different arguments run both launches, each with its own arguments",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(RECIPE_REFERENCE, {
          prefix: PLAN_TWICE_PREFIX,
          launches: [GO, GO],
          projectRecipes: { "kit-recipe": ASKING_RECIPE },
        });

        assert.deepStrictEqual(outcome.problems, []);
        // The two proposals run in parallel, so either may be written first.
        assert.sameDeepMembers(
          outcome.rows.map((row) => [row.state, row.args]),
          TWICE_ARGS.map((args) => ["finished", args])
        );
        assert.deepStrictEqual(starts(outcome.effects), ["first", "second"]);
      }),
    testLimit(30_000)
  );

  it.live(
    "two Goes on one recipe run both launches when the model runs them in one message",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(RECIPE_REFERENCE, {
          prefix: PLAN_TWICE_TOGETHER_PREFIX,
          launches: [GO, GO],
          projectRecipes: { "kit-recipe": ASKING_RECIPE },
        });

        assert.deepStrictEqual(outcome.problems, []);
        assert.sameDeepMembers(
          outcome.rows.map((row) => [row.state, row.args]),
          TWICE_ARGS.map((args) => ["finished", args])
        );
        assert.deepStrictEqual(starts(outcome.effects), ["first", "second"]);
      }),
    testLimit(30_000)
  );

  it.live(
    "two Goes on one inline script run both launches when the model runs them in one message",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(ASKING_RECIPE, {
          prefix: PLAN_TWICE_TOGETHER_PREFIX,
          launches: [GO, GO],
        });

        assert.deepStrictEqual(outcome.problems, []);
        assert.sameDeepMembers(
          outcome.rows.map((row) => [row.state, row.args]),
          TWICE_ARGS.map((args) => ["finished", args])
        );
        assert.deepStrictEqual(starts(outcome.effects), ["first", "second"]);
      }),
    testLimit(30_000)
  );

  it.live(
    "a project recipe launches by name: the plan proposes its file's script and Go runs it",
    () =>
      Effect.gen(function* () {
        const recipe = workflow(
          `return await agent("node:a", { label: "a" });`,
          "kit-recipe"
        );

        const outcome = yield* flow(
          `export const meta = { name: "kit-recipe" };`,
          {
            launches: [GO],
            projectRecipes: { "kit-recipe": recipe },
          }
        );

        assert.deepStrictEqual(outcome.problems, []);

        const [row] = outcome.rows;

        assert.strictEqual(row?.name, "kit-recipe");
        assert.strictEqual(row?.state, "finished");
        assert.deepStrictEqual(starts(outcome.effects), ["a"]);
      }),
    testLimit(30_000)
  );

  it.live(
    "a reference to no recipe is refused before it reaches the user",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(
          `export const meta = { name: "nowhere" };`,
          {
            launches: [GO],
          }
        );

        assert.deepStrictEqual(outcome.rows, []);
        assert.deepStrictEqual(Object.keys(outcome.records), []);
        assert.include(outcome.reply, "no project recipe");
      }),
    testLimit(30_000)
  );

  it.live(
    "Send back on the launch runs nothing, revises the record and gives the model the notes",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, {
          launches: [{ decision: "revise", edits: Option.none() }],
        });

        const [row] = outcome.rows;
        const launch = outcome.records[row?.approvalId ?? ""];

        assert.strictEqual(launch?.status, "revised");
        assert.strictEqual(launch?.reason, "fewer nodes");
        assert.strictEqual(row?.state, "declined");
        assert.deepStrictEqual(row?.nodes, {});
        assert.deepStrictEqual(outcome.effects, []);
        assert.include(
          outcome.reply,
          "sent workflow kit-flow back: fewer nodes"
        );
      }),
    testLimit(30_000)
  );

  it.live(
    "a node's own brief names the model its script named, for the card to check; one that names none runs on the thread's",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, {
          launches: [GO],
          briefs: "accept",
        });

        const nodes = Object.values(outcome.rows[0]?.nodes ?? {});

        const briefOf = (label: string) =>
          decodeBrief(
            outcome.records[
              nodes.find((node) => node.label === label)?.briefId ?? ""
            ]?.payload
          );

        assert.strictEqual(briefOf("e").model, ALT_MODEL);
        assert.isNull(briefOf("a").model);

        const e = nodes.find((node) => node.label === "e");

        assert.deepStrictEqual([e?.provider, e?.modelId], ["faux", "kit-alt"]);
        assert.deepStrictEqual(outcome.problems, []);
      }),
    testLimit(30_000)
  );

  it.live(
    "a launch its model gives no budget carries the server's default, frozen in its payload and row",
    () =>
      Effect.gen(function* () {
        const fallback: Budget = {
          ...DEFAULT_BUDGET,
          maxListMicros: Micros.make(3_000_000),
          maxTokens: 700_000,
        };

        const outcome = yield* flow(
          workflow(`const a = await agent("node:a", { label: "a" });
return { a, total: budget.total };`),
          { launches: [GO], defaultBudget: fallback }
        );

        const [row] = outcome.rows;
        const launch = outcome.records[row?.approvalId ?? ""];

        assert.deepStrictEqual(
          decodeLaunch(launch?.payload).envelope.budget,
          fallback
        );
        assert.strictEqual(row?.budget.maxTokens, 700_000);
        assert.strictEqual(row?.budget.maxListMicros, 3_000_000);
        assert.include(outcome.reply, '"total":700000');
      }),
    testLimit(30_000)
  );

  it.live(
    "Go with the card's edits runs on the edited budget; the frozen payload stays as proposed",
    () =>
      Effect.gen(function* () {
        const edits: LaunchEdits = {
          budget: { ...DEFAULT_BUDGET, maxTokens: 900_000 },
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
        });
        assert.include(outcome.reply, '"total":900000');
      }),
    testLimit(30_000)
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
    testLimit(45_000)
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
    testLimit(30_000)
  );

  it.live(
    "a stop while the launch card waits cancels it and declines the row, and nothing runs",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, { launches: [], stopAt: "launch" });

        const [row] = outcome.rows;
        const launch = outcome.records[row?.approvalId ?? ""];

        assert.strictEqual(launch?.status, "cancelled");
        assert.deepStrictEqual(launch?.decidedBy, {
          kind: "system",
          why: "run-stopped",
        });
        assert.strictEqual(row?.state, "declined");
        assert.deepStrictEqual(row?.decidedBy, {
          kind: "system",
          why: "run-stopped",
        });
        assert.strictEqual(row?.decidedAt, STOPPED_AT);
        assert.deepStrictEqual(row?.nodes, {});
        assert.deepStrictEqual(outcome.effects, []);
        assert.isFalse(
          Object.values(outcome.records).some(
            (record) => record.status === "pending"
          )
        );
      }),
    testLimit(30_000)
  );

  it.live(
    "a stop while a node waits on its own card cancels the card and stops the node",
    () =>
      Effect.gen(function* () {
        const outcome = yield* flow(FIVE, { launches: [GO], stopAt: "card" });

        assert.deepStrictEqual(outcome.problems, []);
        assert.strictEqual(outcome.cards.size, 1, "exactly one card");

        const nodes = Object.values(outcome.rows[0]?.nodes ?? {});
        const waiting = nodes.find((node) => node.label === "e");
        const card = outcome.records[waiting?.briefId ?? ""];

        assert.isTrue(outcome.cards.has(card?.id ?? ""));
        assert.strictEqual(card?.status, "cancelled");
        assert.deepStrictEqual(card?.decidedBy, {
          kind: "system",
          why: "run-stopped",
        });
        assert.strictEqual(waiting?.state, "stopped");
        assert.isNull(waiting?.conversationId ?? null);
        assert.notInclude(starts(outcome.effects), "e");
        assert.isFalse(
          Object.values(outcome.records).some(
            (record) => record.status === "pending"
          )
        );
      }),
    testLimit(30_000)
  );
});
