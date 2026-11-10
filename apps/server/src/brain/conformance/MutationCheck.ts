// The conformance suite's mutation check (ADR 0024): it wraps each harness in a broken seam and
// requires the suite to fail at least five scenarios on each side, both with every seam mutation
// at once and with each mutation alone. The subagent mutations break delivery inside the harness
// and must each fail at least two subagent scenarios (ADR 0028); the read mutations break
// `history`, `entry` and `entryImage`, or `inspect`, and must each fail at least two of the
// scenarios that make that read. The check runs at a shorter timeout than the suite, so it also
// runs each side's unmutated control at that timeout and requires zero failures: a timeout alone
// must not count as a caught mutation.
//
// The check is spread over `mutation-check/`, one file per side and mutation set plus one per side
// for the control, so Vitest runs them on separate workers: a broken pass mostly waits out its
// timeouts, and when one file ran every pass in series the check took five minutes. The gate
// passes only when the control and every set pass, as before; the control now runs beside the
// broken passes instead of ahead of them. It runs once per side, over every scenario the side
// passes, the subagent ones included, since a control in every file made each worker repeat the
// check's most CPU-heavy pass at the same moment. Within a worker a pass runs six scenarios at a
// time, where pi-durable's control holds; at eight it fails. `MUTATION_CHECK_FILES` names every
// file, and `MutationCheck.test.ts` holds the folder to it, so a mutation or a side added without
// its file fails there instead of going unjudged.

import { assert } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";

import { slackened, TEST_SLACK } from "../../EventuallyTestKit.ts";
import {
  isSubagentScenario,
  passingOn,
  SIDES,
  TARGETS,
} from "./ConformanceSuite.ts";
import type { Runner, Side } from "./ConformanceSuite.ts";
import { runScenario } from "./HarnessConformance.ts";
import {
  MUTATIONS,
  READ_LINES,
  READ_MUTATIONS,
  SUBAGENT_MUTATIONS,
} from "./Mutations.ts";
import type { Mutation, ReadMutation, SubagentMutation } from "./Mutations.ts";
import type { MakeTarget } from "./Targets.ts";
import type { Scenario } from "./Transcript.ts";

/**
 * The mutation check's per-scenario timeout; the unmutated control runs at it too. Its slowest
 * line is `subagent_reply_escalate_reason_bounded`'s wait for the escalation: the faux model
 * streams two 4,000-character arguments, a second of streaming at its rate. With three runs of
 * this folder at once that wait took at most 1.4 s once the faux model streamed in large deltas
 * (`Targets.ts`); in small ones it passed this timeout in five of nine such runs. It is the judge's
 * own number, scaled by the test slack like every test deadline: the control runs at the same
 * scaled timeout, so a timeout alone still never counts as a caught mutation.
 */
const MUTATION_TIMEOUT = slackened(Duration.millis(2500));

/** Scenarios each broken side must fail, all mutations together and each alone (ADR 0024). */
const GATE = 5;

/** Subagent scenarios each subagent mutation must fail alone (ADR 0028). */
const SUBAGENT_GATE = 2;

/** Scenarios making the broken read that each read mutation must fail alone. */
const READ_GATE = 2;

/** Scenarios a pass runs at once; see the header. */
const PASS_CONCURRENCY = 6;

/**
 * What one file of the check runs a side with: no mutation (the control), every seam mutation at
 * once, or one mutation alone, a seam mutation or a subagent one.
 */
export type MutationSet = "control" | "all" | Mutation;

const MUTATION_SETS: ReadonlyArray<MutationSet> = [
  "control",
  "all",
  ...MUTATIONS,
  ...SUBAGENT_MUTATIONS,
  ...READ_MUTATIONS,
];

const isSubagentMutation = (set: MutationSet): set is SubagentMutation =>
  SUBAGENT_MUTATIONS.some((mutation) => mutation === set);

const isReadMutation = (set: MutationSet): set is ReadMutation =>
  READ_MUTATIONS.some((mutation) => mutation === set);

/** Whether a scenario makes the read a read mutation breaks. */
const makesRead = (mutation: ReadMutation) => (scenario: Scenario) =>
  scenario.lines.some((line) => READ_LINES[mutation].includes(line.type));

/**
 * What one set is judged on and how many failures it must reach: a subagent mutation the subagent
 * scenarios, a read mutation the scenarios making its read, any other set every scenario.
 */
const judgedOn = (side: Side, set: Exclude<MutationSet, "control">) => {
  if (isSubagentMutation(set)) {
    return {
      among: passingOn(side).filter(isSubagentScenario),
      gate: SUBAGENT_GATE,
      kind: "subagent scenarios",
    };
  }

  if (isReadMutation(set)) {
    return {
      among: passingOn(side).filter(makesRead(set)),
      gate: READ_GATE,
      kind: "scenarios making that read",
    };
  }

  return { among: passingOn(side), gate: GATE, kind: "scenarios" };
};

/** The names of the scenarios among `among` that fail on `target` broken by `mutations`. */
const failures = (
  target: MakeTarget,
  among: ReadonlyArray<Scenario>,
  mutations: ReadonlySet<Mutation>
) =>
  Effect.forEach(
    among,
    (scenario) =>
      Effect.map(
        runScenario(scenario, target, {
          timeout: MUTATION_TIMEOUT,
          mutations,
          awaitAtRest: false,
        }),
        (outcome) => (Option.isSome(outcome.failure) ? [scenario.name] : [])
      ),
    { concurrency: PASS_CONCURRENCY }
  ).pipe(Effect.map((names) => names.flat()));

/** `pi-durable` and `drop_run_terminal` as `PiDurable` and `DropRunTerminal`. */
const pascal = (name: string) =>
  name
    .split(/[-_]/u)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join("");

/** One file of `mutation-check/`: its name, and the one call it makes. */
export interface MutationCheckFile {
  readonly name: string;
  readonly call: string;
}

/** Every file `mutation-check/` must hold, and nothing else. */
export const MUTATION_CHECK_FILES: ReadonlyArray<MutationCheckFile> =
  SIDES.flatMap((side) =>
    MUTATION_SETS.map((set) => ({
      name: `${pascal(side)}${pascal(set)}.test.ts`,
      call: `registerMutationCheck({ describe, it }, "${side}", "${set}");`,
    }))
  );

/** Registers the control: the unmutated side fails none of its scenarios at the check's timeout. */
const registerControl = (runner: Runner, side: Side) => {
  const among = passingOn(side);

  runner.describe("harness conformance mutation check", () => {
    runner.it.live(
      `the unmutated ${side} harness fails no scenario at the check's timeout`,
      () =>
        Effect.gen(function* () {
          const control = yield* failures(TARGETS[side], among, new Set());

          console.log(
            JSON.stringify({
              side,
              mutations: "control",
              among: among.length,
              failed: control,
            })
          );

          assert.deepStrictEqual(
            control,
            [],
            "the unmutated harness fails at the mutation check's timeout, so its counts mean nothing"
          );
        }),
      300_000 * TEST_SLACK
    );
  });
};

/**
 * Registers one file's part of the check on one side: the control, or the side broken by one
 * mutation set, where a seam set must fail five of the scenarios the side passes and a subagent
 * mutation two of its subagent ones.
 */
export const registerMutationCheck = (
  runner: Runner,
  side: Side,
  set: MutationSet
) => {
  if (set === "control") {
    registerControl(runner, side);

    return;
  }

  const subagent = isSubagentMutation(set);
  const { among, gate, kind: scenarioKind } = judgedOn(side, set);
  const broken = set === "all" ? "every seam mutation at once" : `${set} alone`;

  runner.describe("harness conformance mutation check", () => {
    // With no subagent scenario passing on a side yet there is nothing to judge a subagent
    // mutation on; any other set always has scenarios, and fails its gate if it has none.
    runner.it.live.skipIf(subagent && among.length === 0)(
      `a ${side} harness broken by ${broken} fails at least ${gate} ${scenarioKind}`,
      () =>
        Effect.gen(function* () {
          const failed = yield* failures(
            TARGETS[side],
            among,
            new Set(set === "all" ? MUTATIONS : [set])
          );

          console.log(
            JSON.stringify({
              side,
              mutations: set,
              among: among.length,
              failed,
            })
          );

          assert.isAtLeast(
            failed.length,
            gate,
            `${broken} failed fewer than ${gate} ${scenarioKind}`
          );
        }),
      300_000 * TEST_SLACK
    );
  });
};
