// The conformance suite's mutation check (ADR 0024): it wraps each harness in a broken seam and
// requires the suite to fail at least five scenarios on each side, both with every seam mutation
// at once and with each mutation alone. The subagent mutations break delivery inside the harness
// and must each fail at least two subagent scenarios (ADR 0028). The check runs at a shorter
// timeout than the suite, so it also runs each side's unmutated control at that timeout and
// requires zero failures: a timeout alone must not count as a caught mutation.
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

import {
  isSubagentScenario,
  passingOn,
  SIDES,
  TARGETS,
} from "./ConformanceSuite.ts";
import type { Runner, Side } from "./ConformanceSuite.ts";
import { runScenario } from "./HarnessConformance.ts";
import { MUTATIONS, SUBAGENT_MUTATIONS } from "./Mutations.ts";
import type { Mutation, SubagentMutation } from "./Mutations.ts";
import type { MakeTarget } from "./Targets.ts";
import type { Scenario } from "./Transcript.ts";

/**
 * The mutation check's per-scenario timeout; the unmutated control runs at it too. Its slowest
 * line is `subagent_reply_escalate_reason_bounded`'s wait for the escalation: the faux model
 * streams two 4,000-character arguments, a second of streaming at its rate. With three runs of
 * this folder at once that wait took at most 1.4 s once the faux model streamed in large deltas
 * (`Targets.ts`); in small ones it passed this timeout in five of nine such runs.
 */
const MUTATION_TIMEOUT = Duration.millis(2500);

/** Scenarios each broken side must fail, all mutations together and each alone (ADR 0024). */
const GATE = 5;

/** Subagent scenarios each subagent mutation must fail alone (ADR 0028). */
const SUBAGENT_GATE = 2;

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
];

const isSubagentMutation = (set: MutationSet): set is SubagentMutation =>
  SUBAGENT_MUTATIONS.some((mutation) => mutation === set);

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
      300_000
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

  const among = subagent
    ? passingOn(side).filter(isSubagentScenario)
    : passingOn(side);

  const gate = subagent ? SUBAGENT_GATE : GATE;
  const scenarioKind = subagent ? "subagent scenarios" : "scenarios";
  const broken = set === "all" ? "every seam mutation at once" : `${set} alone`;

  runner.describe("harness conformance mutation check", () => {
    // With no subagent scenario passing on a side yet there is nothing to judge a subagent
    // mutation on; a seam set always has scenarios, and fails its gate if it has none.
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
      300_000
    );
  });
};
