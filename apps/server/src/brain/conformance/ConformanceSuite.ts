// The harness seam's outside judge (ADR 0024), shared by the files that run it: every scenario's
// hand-written expectations against both harnesses, the drift goldens, and the mutation check.
// The judge is split over several test files only so Vitest runs its parts on separate workers:
// most of its time is spent waiting out timeouts, not computing, and one file ran it in series for
// seven minutes. The parts are:
//
// - `ConformancePiDurable.test.ts` and `ConformanceScripted.test.ts`: the suite on one side, that
//   side's pending scenarios, and (pi-durable only) the shared runs settled in each order.
// - `ConformanceGoldens.test.ts`: the drift goldens and the brief expiry scenarios.
// - `mutation-check/*.test.ts`: the mutation check (`MutationCheck.ts`), one file per side and
//   mutation set, and one per side for its control.
//
// Scenarios are written before the code that passes them. A scenario listed as pending on a side
// must still fail there; the package that makes it pass removes it from the list, so a pending
// scenario that starts passing fails its side's file until it is promoted. The goldens are
// pi-durable's record, except for a scenario still pending on pi-durable, whose golden is the
// scripted harness's record until pi-durable passes it. Set CAIRN_UPDATE_GOLDENS=1 to rewrite the
// goldens after reviewing a behaviour change.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { assert } from "@effect/vitest";
import { Duration, Effect, Option, Result } from "effect";

import { slackened, TEST_SLACK } from "../../EventuallyTestKit.ts";
import {
  registerHarnessConformance,
  runScenario,
} from "./HarnessConformance.ts";
import type { ConformanceRunner, RunOptions } from "./HarnessConformance.ts";
import type { Mutation } from "./Mutations.ts";
import { piDurableTarget, scriptedTarget } from "./Targets.ts";
import type { MakeTarget } from "./Targets.ts";
import { parseTranscript } from "./Transcript.ts";
import type { Scenario } from "./Transcript.ts";

/** The folder holding `scenarios/` and `goldens/`. */
export const CONFORMANCE_DIR = import.meta.dirname;

/** Every scenario in `scenarios/`, by name. */
export const allScenarios: ReadonlyArray<Scenario> = readdirSync(
  path.join(CONFORMANCE_DIR, "scenarios")
)
  .filter((name) => name.endsWith(".ndjson"))
  .toSorted()
  .map((name) =>
    Result.getOrThrow(
      parseTranscript(
        readFileSync(path.join(CONFORMANCE_DIR, "scenarios", name), "utf-8")
      )
    )
  );

/**
 * Scenarios that wait for a brief to expire. They run on both harnesses with briefs that live
 * `SHORT_BRIEF_TTL_MILLIS` (below), not a week, so they are kept out of the suite's other runs.
 */
export const BRIEF_EXPIRY_SCENARIOS: ReadonlySet<string> = new Set([
  "subagent_brief_expired",
  "subagent_brief_expired_across_restart",
]);

/** A brief's lifetime in the expiry scenarios: long enough to look at it, short enough to wait. */
export const SHORT_BRIEF_TTL_MILLIS = 1000;

/** The scenarios of the suite, the drift goldens and the mutation check. */
export const scenarios = allScenarios.filter(
  (scenario) => !BRIEF_EXPIRY_SCENARIOS.has(scenario.name)
);

/** The subagent scenario groups (ADR 0028), which the subagent mutations are judged on. */
export const isSubagentScenario = (scenario: Scenario) =>
  scenario.name.startsWith("subagent_");

export type Side = "pi-durable" | "scripted";

/**
 * Scenarios each side does not pass yet: none. pi-durable passes the subagent groups with the
 * subagents extension (`subagents/`), and the scripted harness models them.
 *
 * Two windows of the subagents note's groups are judged elsewhere. `subagent_result_once_with_crash`
 * crashes while the child's answer and the parent's woken run are held; the scripted reporter
 * settles and reports in single critical sections a crash line cannot split, so the windows
 * between the child's answer, the settlement and the report belong to 4C's
 * `judges/subagent-durability.ts`. `subagent_brief_declined` covers declined and revised briefs;
 * an expired brief (group 2's third case) is `subagent_brief_expired`, run with a short brief
 * lifetime in `ConformanceGoldens.test.ts`. The kills around Go itself (inside the answering
 * commit, mid-start, five in a row) are `judges/brief-go.sh`'s.
 */
export const PENDING: Readonly<Record<Side, ReadonlySet<string>>> = {
  "pi-durable": new Set(),
  scripted: new Set(),
};

export const TARGETS: Readonly<Record<Side, MakeTarget>> = {
  "pi-durable": piDurableTarget,
  scripted: scriptedTarget,
};

export const SIDES: ReadonlyArray<Side> = ["pi-durable", "scripted"];

export const passingOn = (side: Side) =>
  scenarios.filter((scenario) => !PENDING[side].has(scenario.name));

const pendingOn = (side: Side) =>
  scenarios.filter((scenario) => PENDING[side].has(scenario.name));

/**
 * The suite's run options: no mutation, and a timeout long enough that only a fault trips it (five
 * seconds on a quiet machine, scaled by the test slack).
 */
export const SUITE_OPTIONS: RunOptions = {
  timeout: slackened(Duration.seconds(5)),
  mutations: new Set<Mutation>(),
  awaitAtRest: false,
};

/** The drift goldens' run options: the suite's, with the record taken once every thread is at rest. */
export const GOLDEN_OPTIONS: RunOptions = {
  ...SUITE_OPTIONS,
  awaitAtRest: true,
};

/** The `it.live` of `@effect/vitest`: a test that runs an Effect on the live clock. */
type LiveTest = (
  name: string,
  self: () => Effect.Effect<void>,
  timeout: number
) => void;

/**
 * The test file's own `describe` and `it` (from `@effect/vitest`), which register a part of the
 * judge there. Only the parts used are named, since that package's own types are flagged unstable.
 */
export interface Runner extends ConformanceRunner {
  readonly it: ConformanceRunner["it"] & {
    readonly live: LiveTest & {
      readonly skipIf: (condition: boolean) => LiveTest;
    };
  };
}

/**
 * Registers one side's part of the suite: each scenario it passes as a test of its own, and a test
 * that every scenario still pending on it fails.
 */
export const registerSide = (runner: Runner, side: Side) => {
  registerHarnessConformance(
    runner,
    `${side} harness`,
    TARGETS[side],
    passingOn(side),
    SUITE_OPTIONS
  );

  runner.describe(`${side} harness, pending scenarios`, () => {
    runner.it.live.skipIf(pendingOn(side).length === 0)(
      "every pending scenario still fails",
      () =>
        Effect.gen(function* () {
          const outcomes = yield* Effect.forEach(
            pendingOn(side),
            (scenario) =>
              // At the suite's own timeout, so a scenario that passes there is not counted failing.
              runScenario(scenario, TARGETS[side], SUITE_OPTIONS),
            { concurrency: 6 }
          );

          const passed = outcomes.flatMap((outcome) =>
            Option.isNone(outcome.failure) ? [outcome.scenario] : []
          );

          console.log(
            JSON.stringify({
              side,
              pending: outcomes.length,
              failing: outcomes.length - passed.length,
            })
          );

          assert.deepStrictEqual(
            passed,
            [],
            `these scenarios now pass on the ${side} harness: remove them from PENDING`
          );
        }),
      300_000 * TEST_SLACK
    );
  });
};
