// The goal tools and the judge run under a real pi-durable Harness over pi-ai's faux provider, with
// the thread's commands run in a scratch folder (briefs note, "Criteria and verdicts"):
//
// - a planted false claim: the model says every criterion is met and asks for a check; the command
//   judge exits 1, so the criterion is not met, and nothing the model can call writes a result;
// - a command judge that exits as expected meets its criterion and records HEAD's sha;
// - a second check of a criterion whose run is going queues nothing;
// - `goal_criteria` asks the user and binds nothing; accepting binds the criteria, declining binds
//   none, and a proposal judged by `true` reads as deciding nothing on the card;
// - a model judge that names no model (or a role, recorded before ADR 0043) runs on the thread's own
//   model, one of the thread's family runs when named, and one on the Claude bridge is refused and
//   runs nothing; each verdict records its model and reply, having read the rubric and transcript;
// - a subagent's thread has no goal tools;
// - a kill during a judge run (the Harness closed while its command runs, then reopened on the same
//   store) reruns the command and records one verdict and one note;
// - a judge run the crash-loop guard parked does not hold its criterion: a second check settles
//   its item and queues a fresh run.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { judgeChip, judgeWarning } from "@cairn/client-logic/GoalProgress";
import {
  RequestBody,
  requestBodyOf,
} from "@cairn/client-logic/PendingRequests";
import type { ModelRef } from "@cairn/protocol/Models";
import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { ApprovalRecord as ApprovalRecordSchema } from "@cairn/protocol/Policy";
import type { JudgeRef } from "@cairn/protocol/Policy";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DEFAULT_RESTART_LIMIT,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Result, Schema } from "effect";

import { answerApproval, Approvals } from "../brain/CairnDocs.ts";
import { taskOf } from "../subagents/Delivery.ts";
import { ChildDoc } from "../subagents/SubagentDocs.ts";
import { JudgeRunsDoc } from "./GoalDocs.ts";
import {
  callTool,
  createGoalThread,
  openGoalKit,
  readGoal,
  readRuns,
  say,
  send,
  toolResults,
  verdictNotes,
  waitForJudges,
} from "./GoalTestKit.ts";
import type { GoalKit, KitModel } from "./GoalTestKit.ts";
import { NO_JUDGE_FAULTS } from "./JudgeRun.ts";
import type { JudgeModels } from "./JudgeRun.ts";
import { bindCriteria, criteriaAnswered } from "./Verdicts.ts";

const context = BACKGROUND_CONTEXT;

const CLAUDE: KitModel = { provider: "anthropic", modelId: "claude-test" };

const decodeRecord = Schema.decodeUnknownOption(ApprovalRecordSchema);

/** A judge model table: a literal `provider/modelId` resolves; the reply is `reply`. */
const judgesAnswering = (
  reply: string
): JudgeModels & { readonly prompts: Array<string> } => {
  const prompts: Array<string> = [];

  return {
    prompts,
    resolve: async (spec) => {
      const [provider, modelId] = spec.split("/");

      return await Promise.resolve(
        provider === undefined || modelId === undefined
          ? Result.fail(`${spec} does not resolve.`)
          : Result.succeed<ModelRef>({ provider, modelId })
      );
    },
    ask: async (_model, _system, prompt) => {
      prompts.push(prompt);

      return await Promise.resolve(Result.succeed(reply));
    },
    roleNameRead: async () => {
      await Promise.resolve();
    },
  };
};

const command = (argv: ReadonlyArray<string>): JudgeRef => ({
  kind: "command",
  argv: [argv[0] ?? "true", ...argv.slice(1)],
  expectExit: 0,
  timeoutSec: 60,
});

/** A model judge naming `spec`, or none for the thread's own model. */
const modelJudge = (spec: string | null): JudgeRef => ({
  kind: "model",
  spec: spec === null ? null : ModelSpec.make(spec),
  rubric: "A test run with no failures",
});

const scratch = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-goal-"))),
  (dir) =>
    Effect.sync(() => {
      rmSync(dir, { recursive: true, force: true });
    })
);

const kitOver = (options: Parameters<typeof openGoalKit>[0]) =>
  Effect.acquireRelease(
    Effect.promise(async () => await openGoalKit(options, context)),
    (kit) =>
      Effect.promise(async () => {
        await kit.close();
      })
  );

const thread = (
  kit: GoalKit,
  cwd: string,
  criteria: ReadonlyArray<{ readonly text: string; readonly judge: JudgeRef }>
) =>
  Effect.promise(
    async () =>
      await createGoalThread(
        kit,
        {
          threadId: "thread-goal",
          cwd,
          model: CLAUDE,
          objective: "Ship the parser",
          criteria,
          now: 1,
        },
        context
      )
  );

describe("the goal tools under a Harness", () => {
  it.live(
    "a planted false claim: the command judge exits 1 and the criterion is not met",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t1"),
            say("All criteria are met. The parser ships."),
          ],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, [
          {
            text: "Tests pass",
            judge: command(["sh", "-c", "echo 3 tests failed; exit 1"]),
          },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Finish.", "r-1", context);
        });

        assert.isTrue(
          yield* Effect.promise(
            async () => await waitForJudges(kit, conversation, 10_000, context)
          )
        );

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        const criterion = goal?.criteria[0];

        assert.strictEqual(criterion?.state, "failed");
        assert.strictEqual(criterion?.verdict?.evidence.exit, 1);
        assert.include(
          criterion?.verdict?.evidence.tail ?? "",
          "3 tests failed"
        );
        assert.strictEqual(criterion?.tries, 1);

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t1") ?? "", "Queued judge run judge-");
        assert.notInclude(results.get("t1") ?? "", "is met");

        const notes = yield* Effect.promise(
          async () => await verdictNotes(conversation, context)
        );

        assert.strictEqual(notes.length, 1);
        assert.include(JSON.stringify(notes[0]?.model ?? []), "is not met");
      }).pipe(Effect.scoped)
  );

  it.live(
    "a command judge that exits as expected meets its criterion and records HEAD",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        execFileSync("git", ["init", "-q"], { cwd });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=judge",
            "-c",
            "user.email=judge@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "start",
          ],
          { cwd }
        );

        const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd })
          .toString()
          .trim();

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [callTool("goal_check", { criterion: "c1" }, "t1")],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, [
          { text: "Tests pass", judge: command(["sh", "-c", "echo ok"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check.", "r-1", context);
        });
        yield* Effect.promise(
          async () => await waitForJudges(kit, conversation, 10_000, context)
        );

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.strictEqual(goal?.criteria[0]?.state, "met");
        assert.strictEqual(goal?.criteria[0]?.verdict?.evidence.sha, head);
        assert.strictEqual(goal?.criteria[0]?.verdict?.evidence.exit, 0);
      }).pipe(Effect.scoped)
  );

  it.live(
    "a second check of a criterion whose run is going queues nothing",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t1"),
            callTool("goal_check", { criterion: "c1" }, "t2"),
          ],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, [
          { text: "Slow", judge: command(["sh", "-c", "sleep 1"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check twice.", "r-1", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t2") ?? "", "already queued or running");

        yield* Effect.promise(
          async () => await waitForJudges(kit, conversation, 10_000, context)
        );

        const runs = yield* Effect.promise(
          async () => await readRuns(kit, conversation, context)
        );

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.strictEqual(Object.keys(runs?.items ?? {}).length, 1);
        assert.strictEqual(goal?.criteria[0]?.tries, 1);
      }).pipe(Effect.scoped)
  );

  it.live(
    "goal_criteria asks the user; accepting binds, declining binds none, and a judge of true reads as deciding nothing",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool(
              "goal_criteria",
              {
                criteria: [
                  { text: "It works", judge: "command", argv: ["true"] },
                  { text: "The user likes it", judge: "user" },
                ],
              },
              "t1"
            ),
            callTool(
              "goal_criteria",
              { criteria: [{ text: "Fast", judge: "user" }] },
              "t2"
            ),
          ],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, []);

        yield* Effect.promise(async () => {
          await send(conversation, "Propose.", "r-1", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(
          results.get("t1") ?? "",
          "waiting for the user's approval"
        );

        const approvals = yield* Effect.promise(
          async () =>
            await kit.harness.snapshot(Approvals, conversation.id, context)
        );

        const records = Object.values(approvals?.items ?? {}).toSorted(
          (a, b) => a.toolTaskId - b.toolTaskId
        );

        assert.deepStrictEqual(
          records.map((record) => [record.kind, record.status]),
          [
            ["criteria", "pending"],
            ["criteria", "pending"],
          ]
        );

        const before = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.strictEqual(before?.criteria.length ?? 0, 0);

        // The card the user reads: the proposal's command whole, and that it decides nothing.
        const decoded = decodeRecord(records[0]);

        assert.isTrue(Option.isSome(decoded));

        const body = Option.map(decoded, requestBodyOf);

        const judges =
          Option.isSome(body) && RequestBody.$is("Criteria")(body.value)
            ? body.value.criteria.map((criterion) => criterion.judge)
            : [];

        assert.strictEqual(judges.length, 2);
        assert.strictEqual(
          judgeChip(judges[0] ?? { kind: "user" }),
          "Command: true"
        );
        assert.isTrue(
          Option.isSome(judgeWarning(judges[0] ?? { kind: "user" }))
        );

        const answer = (id: string, decision: "accept" | "decline") =>
          answerApproval(
            kit.harness,
            conversation.id,
            id,
            {
              decision,
              by: { kind: "user" },
              reason: Option.none(),
              answers: Option.none(),
              launch: Option.none(),
            },
            50,
            criteriaAnswered
          );

        assert.strictEqual(
          yield* answer(records[0]?.id ?? "", "accept"),
          "answered"
        );
        assert.strictEqual(
          yield* answer(records[1]?.id ?? "", "decline"),
          "answered"
        );

        const after = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.deepStrictEqual(
          after?.criteria.map((criterion) => [
            criterion.id,
            criterion.text,
            criterion.state,
            criterion.changedAt,
          ]),
          [
            ["c1", "It works", "open", 50],
            ["c2", "The user likes it", "open", 50],
          ]
        );
      }).pipe(Effect.scoped)
  );

  it.live(
    "a model judge runs on the thread's own model when it names none, of any family when named, never on the bridge",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const judges = judgesAnswering(
          "MET\nThe user's message shows 12 passed."
        );

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t1"),
            callTool("goal_check", { criterion: "c2" }, "t2"),
            callTool("goal_check", { criterion: "c3" }, "t3"),
            callTool("goal_check", { criterion: "c4" }, "t4"),
          ],
          judges,
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, [
          // Names no model: the thread's own judges (ADR 0043).
          { text: "Tests pass", judge: modelJudge(null) },
          // The thread's family, named: no longer refused.
          {
            text: "Tests pass, judged by a cousin",
            judge: modelJudge("opencode-go/claude-haiku-5-5"),
          },
          // A judge recorded before ADR 0043 names a role: it reads as none.
          { text: "Tests pass, judged by a role", judge: modelJudge("@judge") },
          {
            text: "Tests pass, judged on the bridge",
            judge: modelJudge("claude-bridge/claude-haiku-5-5"),
          },
        ]);

        yield* Effect.promise(async () => {
          await send(
            conversation,
            "npm test printed: 12 passed, 0 failed.",
            "r-1",
            context
          );
        });
        yield* Effect.promise(
          async () => await waitForJudges(kit, conversation, 10_000, context)
        );

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t4") ?? "", "Claude bridge");
        assert.strictEqual(judges.prompts.length, 3);
        assert.include(
          judges.prompts[0] ?? "",
          "Rubric: A test run with no failures"
        );
        assert.include(judges.prompts[0] ?? "", "12 passed, 0 failed");

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.deepStrictEqual(
          goal?.criteria.map((criterion) => [
            criterion.state,
            criterion.verdict?.evidence.model ?? null,
          ]),
          [
            ["met", "anthropic/claude-test"],
            ["met", "opencode-go/claude-haiku-5-5"],
            ["met", "anthropic/claude-test"],
            ["open", null],
          ]
        );
        assert.include(
          goal?.criteria[0]?.verdict?.evidence.note ?? "",
          "12 passed"
        );
      }).pipe(Effect.scoped)
  );

  it.live("a subagent's thread has no goal tools", () =>
    Effect.gen(function* () {
      const cwd = yield* scratch;

      const kit = yield* kitOver({
        storage: new MemoryStorage(),
        model: CLAUDE,
        responses: [callTool("goal_check", {}, "t1")],
        judges: judgesAnswering("MET"),
        faults: NO_JUDGE_FAULTS,
      });

      const conversation = yield* Effect.promise(
        async () =>
          await kit.harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent: { model: CLAUDE, cwd },
              init: async (tx, id) => {
                const link = await tx.doc(ChildDoc, id);

                link.parentConversationId = 1;
              },
            },
            context
          )
      );

      yield* Effect.promise(async () => {
        await send(conversation, "Check.", "r-1", context);
      });

      const results = yield* Effect.promise(
        async () => await toolResults(conversation, context)
      );

      assert.include(results.get("t1") ?? "", "brief's done-when criteria");
    }).pipe(Effect.scoped)
  );

  it.live(
    "a judge run whose judging throws still settles: a later check queues a fresh run and its verdict arrives",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;
        const thrown = { once: false };

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t1"),
            say("Queued."),
            callTool("goal_check", { criterion: "c1" }, "t2"),
            say("Queued again."),
          ],
          judges: judgesAnswering("MET"),
          // A fault inside the judge phase that is not an abort: the first run's phase throws.
          faults: {
            at: (point) => {
              if (point === "judged" && !thrown.once) {
                thrown.once = true;
                throw new Error("the judge broke");
              }
            },
            control: "none",
          },
        });

        const conversation = yield* thread(kit, cwd, [
          { text: "Tests pass", judge: command(["true"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check.", "r-1", context);
        });

        const first = yield* Effect.promise(
          async () => await readRuns(kit, conversation, context)
        );

        const [queued] = Object.values(first?.items ?? {});

        assert.isDefined(queued);

        // The first run ends however its phase's throw ends it.
        yield* Effect.promise(async () => {
          await kit.harness.waitForTask(taskOf(queued?.taskId ?? 0), context);
        });

        yield* Effect.promise(async () => {
          await send(conversation, "Check again.", "r-2", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t2") ?? "", "Queued judge run judge-");

        assert.isTrue(
          yield* Effect.promise(
            async () => await waitForJudges(kit, conversation, 10_000, context)
          )
        );

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        const notes = yield* Effect.promise(
          async () => await verdictNotes(conversation, context)
        );

        assert.strictEqual(goal?.criteria[0]?.state, "met");
        assert.isAtLeast(notes.length, 1);
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "an index item whose run ended without settling it does not hold its criterion",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t1"),
            say("Queued."),
            callTool("goal_check", { criterion: "c1" }, "t2"),
            say("Queued again."),
          ],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const conversation = yield* thread(kit, cwd, [
          { text: "Tests pass", judge: command(["true"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check.", "r-1", context);
          await waitForJudges(kit, conversation, 10_000, context);
        });

        // As a task that faulted in its completing commit leaves it: ended, its item unsettled.
        const dead = yield* Effect.promise(
          async () =>
            await kit.harness.commit(async (tx) => {
              const runs = await tx.doc(JudgeRunsDoc, conversation.id);

              for (const item of Object.values(runs.items)) {
                item.settledAt = null;
              }

              return Object.keys(runs.items);
            }, context)
        );

        assert.strictEqual(dead.length, 1);

        yield* Effect.promise(async () => {
          await send(conversation, "Check again.", "r-2", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t2") ?? "", "Queued judge run judge-");

        const runs = yield* Effect.promise(
          async () => await readRuns(kit, conversation, context)
        );

        const items = Object.values(runs?.items ?? {});

        assert.strictEqual(items.length, 2);
        assert.isNotNull(
          runs?.items[dead[0] ?? ""]?.settledAt ?? null,
          "the dead item is settled"
        );
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "a criterion minted with a dropped criterion's id gets its own run, not the dropped one's",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;

        const kit = yield* kitOver({
          storage: new MemoryStorage(),
          model: CLAUDE,
          responses: [
            callTool("goal_check", { criterion: "c3" }, "t1"),
            say("Queued."),
            callTool("goal_check", { criterion: "c3" }, "t2"),
            say("Queued the new one."),
          ],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        });

        const kept = [
          { text: "Tests pass", judge: command(["true"]) },
          { text: "Lint passes", judge: command(["true"]) },
        ];

        const conversation = yield* thread(kit, cwd, [
          ...kept,
          { text: "Slow", judge: command(["sh", "-c", "sleep 2"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check c3.", "r-1", context);
        });

        // The user drops c3 while its run goes, then binds a new criterion, which is minted c3.
        yield* Effect.promise(async () => {
          await kit.harness.commit(async (tx) => {
            await bindCriteria(
              tx,
              conversation.id,
              { objective: Option.none(), criteria: kept, mode: "replace" },
              2
            );
            await bindCriteria(
              tx,
              conversation.id,
              {
                objective: Option.none(),
                criteria: [{ text: "Docs build", judge: command(["true"]) }],
                mode: "append",
              },
              3
            );
          }, context);
        });

        const goal = yield* Effect.promise(
          async () => await readGoal(kit, conversation, context)
        );

        assert.deepStrictEqual(
          goal?.criteria.map((criterion) => [criterion.id, criterion.text]),
          [
            ["c1", "Tests pass"],
            ["c2", "Lint passes"],
            ["c3", "Docs build"],
          ]
        );

        yield* Effect.promise(async () => {
          await send(conversation, "Check the new c3.", "r-2", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(conversation, context)
        );

        assert.include(results.get("t2") ?? "", "Queued judge run judge-");
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "a kill during a judge run reruns its command and records one verdict and one note",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;
        const store = path.join(cwd, "brain.sqlite");
        const runs = path.join(cwd, "runs.txt");

        const options = {
          storage: yield* Effect.promise(
            async () => await openNodeSqliteStorage(store)
          ),
          model: CLAUDE,
          responses: [callTool("goal_check", { criterion: "c1" }, "t1")],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        };

        const first = yield* Effect.promise(
          async () => await openGoalKit(options, context)
        );

        const conversation = yield* thread(first, cwd, [
          {
            text: "Slow tests pass",
            judge: command(["sh", "-c", `echo run >> ${runs}; sleep 1`]),
          },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check.", "r-1", context);
        });

        const lines = () => {
          try {
            return readFileSync(runs, "utf-8").split("\n").filter(Boolean)
              .length;
          } catch {
            return 0;
          }
        };

        // The command has started: the kill lands inside the judge run.
        for (let waited = 0; lines() === 0 && waited < 100; waited += 1) {
          yield* Effect.promise(async () => {
            await sleep(20);
          });
        }

        assert.strictEqual(lines(), 1);

        yield* Effect.promise(async () => {
          await first.close();
        });

        const second = yield* kitOver({
          ...options,
          storage: yield* Effect.promise(
            async () => await openNodeSqliteStorage(store)
          ),
          responses: [],
        });

        const again = yield* Effect.promise(
          async () =>
            await second.harness.conversation(conversation.id, context)
        );

        assert.isDefined(again);

        if (again === undefined) {
          return;
        }

        assert.isTrue(
          yield* Effect.promise(
            async () => await waitForJudges(second, again, 15_000, context)
          )
        );

        const goal = yield* Effect.promise(
          async () => await readGoal(second, again, context)
        );

        const notes = yield* Effect.promise(
          async () => await verdictNotes(again, context)
        );

        assert.strictEqual(lines(), 2);
        assert.strictEqual(goal?.criteria[0]?.state, "met");
        assert.strictEqual(goal?.criteria[0]?.tries, 1);
        assert.strictEqual(notes.length, 1);
      }).pipe(Effect.scoped),
    30_000
  );

  it.live(
    "a judge run the crash-loop guard parked does not hold its criterion",
    () =>
      Effect.gen(function* () {
        const cwd = yield* scratch;
        const store = path.join(cwd, "brain.sqlite");

        const options = {
          storage: yield* Effect.promise(
            async () => await openNodeSqliteStorage(store)
          ),
          model: CLAUDE,
          responses: [callTool("goal_check", { criterion: "c1" }, "t1")],
          judges: judgesAnswering("MET"),
          faults: NO_JUDGE_FAULTS,
        };

        const first = yield* Effect.promise(
          async () => await openGoalKit(options, context)
        );

        const conversation = yield* thread(first, cwd, [
          { text: "Slow tests pass", judge: command(["sleep", "30"]) },
        ]);

        yield* Effect.promise(async () => {
          await send(conversation, "Check.", "r-1", context);
        });

        const queued = yield* Effect.promise(
          async () => await readRuns(first, conversation, context)
        );

        const [parkedKey, parkedItem] = Object.entries(
          queued?.items ?? {}
        )[0] ?? ["", undefined];

        assert.isDefined(parkedItem);

        yield* Effect.promise(async () => {
          await first.close();
        });

        // As the crash-loop guard leaves a run cut off at the limit: live, and parked until a retry.
        const storage = yield* Effect.promise(
          async () => await openNodeSqliteStorage(store)
        );

        yield* Effect.promise(async () => {
          const record = await storage.task(
            taskOf(parkedItem?.taskId ?? 0),
            context
          );

          assert.isDefined(record);

          if (record !== undefined) {
            await storage.commit(
              [
                {
                  type: "task",
                  value: { ...record, restarts: DEFAULT_RESTART_LIMIT },
                },
              ],
              context
            );
          }
        });

        const second = yield* kitOver({
          ...options,
          storage,
          responses: [
            callTool("goal_check", { criterion: "c1" }, "t2"),
            say("Queued again."),
          ],
        });

        const again = yield* Effect.promise(
          async () =>
            await second.harness.conversation(conversation.id, context)
        );

        assert.isDefined(again);

        if (again === undefined) {
          return;
        }

        yield* Effect.promise(async () => {
          await send(again, "Check again.", "r-2", context);
        });

        const results = yield* Effect.promise(
          async () => await toolResults(again, context)
        );

        assert.include(results.get("t2") ?? "", "Queued judge run judge-");

        const runs = yield* Effect.promise(
          async () => await readRuns(second, again, context)
        );

        assert.strictEqual(Object.keys(runs?.items ?? {}).length, 2);
        assert.isNotNull(
          runs?.items[parkedKey]?.settledAt ?? null,
          "the parked run's item is settled"
        );
      }).pipe(Effect.scoped),
    30_000
  );
});
