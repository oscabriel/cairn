// The goal the goal chip judge (judges/goal-chip.ts, plan 6H) and the look tool's goal state put on
// the seeded project thread of judges/fixtures/parity/CairnApp.ts, over the scripted harness's goals.
// No provider is called and nothing is billed.
//
// The goal is bound as the user binds one (`GoalBook.setCriteria`, the `goal.setCriteria` RPC's
// service), and every verdict is the verdict writer's (`Verdicts.applyVerdict`, in the harness's
// line through `ScriptedGoals.change`), never a state written by hand:
//
// - a `command` judge's run executes its argv for real, here in the brain's process, and records
//   its exit code and the tail of its output, as `JudgeRun.ts` does;
// - the `model` judge names `opencode-go/gpt-6-luna`, another family than the thread's scripted
//   model (the binding refuses one of the same family); its run is played, with the reply a model
//   judge would give, since no model is asked;
// - the `user` judge's criterion stays open for the user to mark through the page (`goal.mark`).

import { execFileSync } from "node:child_process";

import type { CriterionProposal } from "@cairn/protocol/Policy";
import { RoleSpec } from "@cairn/protocol/Roles";
import { Clock, Effect, Option } from "effect";

import { ScriptedGoals } from "../../../apps/server/src/brain/ScriptedHarness.ts";
import { GoalBook } from "../../../apps/server/src/verdicts/GoalBook.ts";
import type {
  EvidenceState,
  GoalState,
} from "../../../apps/server/src/verdicts/GoalDocs.ts";
import { applyVerdict } from "../../../apps/server/src/verdicts/Verdicts.ts";
import type { VerdictOutcome } from "../../../apps/server/src/verdicts/Verdicts.ts";
import type { CairnApp } from "../parity/CairnApp.ts";
import { PARITY_THREAD_ID } from "../parity/CairnApp.ts";

/** The goal's objective. */
export const OBJECTIVE = "Ship the parser with its docs";

/** The model judge's model: of another family than the thread's scripted model. */
export const JUDGE_MODEL = "opencode-go/gpt-6-luna";

/** The criteria, in the order they are bound: ids `c1` to `c4` on a fresh goal. */
export const CRITERIA = {
  tests: {
    text: "The parser's tests pass",
    judge: {
      kind: "command",
      argv: ["node", "-e", "console.log('12 passed')"],
      expectExit: 0,
      timeoutSec: 60,
    },
  },
  readme: {
    text: "The README says how to run it",
    judge: {
      kind: "model",
      spec: RoleSpec.make(JUDGE_MODEL),
      rubric: "The README names the command that runs the parser",
    },
  },
  messages: {
    text: "Its error messages read well to you",
    judge: { kind: "user" },
  },
  lint: {
    text: "Lint is clean",
    judge: {
      kind: "command",
      argv: ["node", "-e", "console.log('0 problems')"],
      expectExit: 0,
      timeoutSec: 60,
    },
  },
} satisfies Record<string, CriterionProposal>;

/** A criterion's name in `CRITERIA`. */
export type CriterionName = keyof typeof CRITERIA;

const NAMES: ReadonlyArray<CriterionName> = [
  "tests",
  "readme",
  "messages",
  "lint",
];

/** What a played model judge answered. */
const MODEL_REPLY =
  "NOT MET. The README describes the parser but names no command that runs it.";

const NO_EVIDENCE: EvidenceState = {
  exit: null,
  tail: null,
  sha: null,
  model: null,
  note: null,
};

/** The criterion's id on the goal as bound now, by its words. */
const idOf = (goal: GoalState, name: CriterionName): Option.Option<string> =>
  Option.map(
    Option.fromUndefinedOr(
      goal.criteria.find((criterion) => criterion.text === CRITERIA[name].text)
    ),
    (criterion) => criterion.id
  );

/**
 * Records one judge run's verdict on the criterion named `name`, through the verdict writer, as
 * the run's completing commit does: the criterion as it stands, its own judge, a fresh run id.
 */
const recordRun = (name: CriterionName, ok: boolean, evidence: EvidenceState) =>
  Effect.gen(function* () {
    const goals = yield* ScriptedGoals;
    const at = yield* Clock.currentTimeMillis;

    const outcome = yield* goals.change(
      PARITY_THREAD_ID,
      (goal): VerdictOutcome => {
        const id = idOf(goal, name);

        const criterion = goal.criteria.find((item) =>
          Option.contains(id, item.id)
        );

        if (criterion === undefined) {
          return "stale";
        }

        return applyVerdict(goal, {
          criterionId: criterion.id,
          changedAt: criterion.changedAt,
          verdict: {
            at,
            ok,
            judge: criterion.judge,
            evidence,
            runId: `judge-${name}-${String(at)}`,
          },
        });
      }
    );

    if (!Option.contains(outcome, "recorded")) {
      return yield* Effect.die(
        `the ${name} verdict was not recorded (${Option.getOrElse(outcome, () => "no thread")})`
      );
    }

    return yield* Effect.void;
  });

/** Runs a command criterion's argv and records its verdict: exit code and the output's tail. */
export const runCommandJudge = (name: "tests" | "lint") =>
  Effect.gen(function* () {
    const { argv, expectExit } = CRITERIA[name].judge;
    const [program, ...args] = argv;

    // A command that exits otherwise than 0 throws; its exit then reads 1, enough for a verdict.
    const run = yield* Effect.try({
      try: () => ({
        exit: 0,
        tail: execFileSync(program, args, { encoding: "utf-8" }).trim(),
      }),
      catch: () => "failed",
    }).pipe(Effect.orElseSucceed(() => ({ exit: 1, tail: "" })));

    yield* recordRun(name, run.exit === expectExit, {
      ...NO_EVIDENCE,
      exit: run.exit,
      tail: run.tail,
    });
  });

/** Plays the model judge's run: not met, with the judge's model and reply as evidence. */
const runModelJudge = recordRun("readme", false, {
  ...NO_EVIDENCE,
  model: JUDGE_MODEL,
  note: MODEL_REPLY,
});

/**
 * The goal as the judge starts from: the four criteria bound by the user, the tests run (met), the
 * model's run (not met), the user's and lint's open. "1 of 4 met, 1 not met".
 */
export const seedGoal = Effect.gen(function* () {
  const book = yield* GoalBook;

  // A fresh binding: an empty list first, so every criterion is open and bound anew.
  yield* book.setCriteria({
    threadId: PARITY_THREAD_ID,
    objective: Option.some(OBJECTIVE),
    criteria: [],
  });
  yield* book.setCriteria({
    threadId: PARITY_THREAD_ID,
    objective: Option.some(OBJECTIVE),
    criteria: NAMES.map((name) => CRITERIA[name]),
  });
  yield* runCommandJudge("tests");
  yield* runModelJudge;
});

/** The goal taken away: no criteria, so the thread is not a goal (the look tool's other states). */
export const clearGoal = GoalBook.use((book) =>
  book.setCriteria({
    threadId: PARITY_THREAD_ID,
    objective: Option.none(),
    criteria: [],
  })
);

/** The project thread's goal as the brain holds it now: each criterion's words and state. */
export const goalRecords = Effect.gen(function* () {
  const goals = yield* ScriptedGoals;

  const goal = yield* goals.read(PARITY_THREAD_ID);

  return Option.match(goal, {
    onNone: () => [],
    onSome: (found) =>
      found.criteria.map((criterion) => ({
        id: criterion.id,
        text: criterion.text,
        judge: criterion.judge.kind,
        state: criterion.state,
        verdictJudge: criterion.verdict?.judge.kind ?? null,
      })),
  });
});

/** Seeds the goal in a running app. */
export const seedGoalIn = async (app: CairnApp): Promise<void> => {
  await app.inBrain(seedGoal);
};
