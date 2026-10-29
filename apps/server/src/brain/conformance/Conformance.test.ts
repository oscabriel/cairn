// The harness seam's outside judge (ADR 0024): every scenario's hand-written expectations against
// both harnesses, the drift goldens, and the mutation check, which wraps each harness in a broken
// seam and requires the suite to fail at least five scenarios on each side, both with every
// mutation at once and with each mutation alone. The subagent mutations break delivery inside the
// harness and must each fail at least two subagent scenarios (ADR 0028). The mutation check runs at
// a shorter timeout than the suite, so it first runs the unmutated control at that timeout and
// requires zero failures: a timeout alone must not count as a caught mutation. Set
// CAIRN_UPDATE_GOLDENS=1 to rewrite the goldens after reviewing a behaviour change.
//
// Scenarios are written before the code that passes them. A scenario listed as pending on a side
// must still fail there; the package that makes it pass removes it from the list, so a pending
// scenario that starts passing fails this file until it is promoted. The goldens are pi-durable's
// record, except for a scenario still pending on pi-durable, whose golden is the scripted
// harness's record until pi-durable passes it.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Result, Schema } from "effect";

import { DEFAULT_TOOL_OPTIONS } from "../../subagents/SubagentTools.ts";
import {
  registerHarnessConformance,
  runScenario,
} from "./HarnessConformance.ts";
import type { Mutation } from "./Mutations.ts";
import { MUTATIONS, SUBAGENT_MUTATIONS } from "./Mutations.ts";
import { jsonEquals } from "./Normalize.ts";
import {
  piDurableTarget,
  piDurableTargetWith,
  scriptedTarget,
} from "./Targets.ts";
import type { MakeTarget } from "./Targets.ts";
import { parseTranscript } from "./Transcript.ts";
import type { Scenario } from "./Transcript.ts";

const here = import.meta.dirname;

const scenarios: ReadonlyArray<Scenario> = readdirSync(
  path.join(here, "scenarios")
)
  .filter((name) => name.endsWith(".ndjson"))
  .toSorted()
  .map((name) =>
    Result.getOrThrow(
      parseTranscript(readFileSync(path.join(here, "scenarios", name), "utf-8"))
    )
  );

/** The subagent scenario groups (ADR 0028), which the subagent mutations are judged on. */
const isSubagentScenario = (scenario: Scenario) =>
  scenario.name.startsWith("subagent_");

type Side = "pi-durable" | "scripted";

/**
 * Scenarios each side does not pass yet: none. pi-durable passes the subagent groups with the
 * subagents extension (`subagents/`), and the scripted harness models them.
 *
 * Two windows of the subagents note's groups are judged elsewhere. `subagent_result_once_with_crash`
 * crashes while the child's answer and the parent's woken run are held; the scripted reporter
 * settles and reports in single critical sections a crash line cannot split, so the windows
 * between the child's answer, the settlement and the report belong to 4C's
 * `judges/subagent-durability.ts`. `subagent_brief_declined` covers declined and revised briefs;
 * an expired brief (group 2's third case) belongs to 4A, which owns expiry.
 */
const PENDING: Readonly<Record<Side, ReadonlySet<string>>> = {
  "pi-durable": new Set(),
  scripted: new Set(),
};

const TARGETS: Readonly<Record<Side, MakeTarget>> = {
  "pi-durable": piDurableTarget,
  scripted: scriptedTarget,
};

const SIDES: ReadonlyArray<Side> = ["pi-durable", "scripted"];

const passingOn = (side: Side) =>
  scenarios.filter((scenario) => !PENDING[side].has(scenario.name));

const pendingOn = (side: Side) =>
  scenarios.filter((scenario) => PENDING[side].has(scenario.name));

const runner = { describe, it };

const decodeGolden = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json)
);

const options = {
  timeout: Duration.seconds(5),
  mutations: new Set<Mutation>(),
};

registerHarnessConformance(
  runner,
  "pi-durable harness",
  piDurableTarget,
  passingOn("pi-durable"),
  options
);

registerHarnessConformance(
  runner,
  "scripted harness",
  scriptedTarget,
  passingOn("scripted"),
  options
);

describe.each(SIDES)("%s harness, pending scenarios", (side) => {
  it.live.skipIf(pendingOn(side).length === 0)(
    "every pending scenario still fails",
    () =>
      Effect.gen(function* () {
        const outcomes = yield* Effect.forEach(
          pendingOn(side),
          (scenario) =>
            // At the suite's own timeout, so a scenario that passes there is not counted failing.
            runScenario(scenario, TARGETS[side], options),
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
    300_000
  );
});

/**
 * The scenarios where a user's quiet input and a waking one reach a child close together: one run
 * ends both (answered, failed or nudged), or two runs each end one, alike, before the first run's
 * reporter settles; and a typed result a later run accepted before the earlier run's reporter
 * settled, an earlier run that was stopped with no entry of its own included; and a run a steer
 * joined, stopped after it accepted a typed result, so the result goes with that run's one
 * settlement whichever of its reporters settles first; and a steer a failed run kept, placed with
 * the next input in one commit, so that run settles once.
 */
const SHARED_RUN_SCENARIOS: ReadonlySet<string> = new Set([
  "subagent_kept_steer_shares_next_failed_run",
  "subagent_send_and_user_message_fail_alike_in_two_runs",
  "subagent_send_and_user_steer_share_a_run",
  "subagent_send_steer_shares_a_stopped_run",
  "subagent_typed_brief_run_shares_user_steer",
  "subagent_typed_nudge_run_shares_user_steer",
  "subagent_typed_result_after_stopped_run",
  "subagent_typed_result_late_reporter",
  "subagent_typed_steer_then_result_stopped",
  "subagent_user_message_and_send_fail_alike_in_two_runs",
  "subagent_user_steer_and_send_share_a_failed_run",
  "subagent_user_steer_and_send_share_a_run",
  "subagent_user_steer_shares_a_stopped_run",
]);

/** How long the reporter held back waits before it settles, so the other one settles first. */
const HELD_SETTLE_DELAY_MILLIS = 300;

// On pi-durable the reporters of a shared run settle in whatever order their commits land. Each
// order is forced here: with the waking ones held back the user's quiet steer settles the run
// first, and with the quiet one held back a waking one does. Either way the parent is woken once,
// with one settlement (ADR 0028: only a stop may lose a wake).
describe.each([
  { first: "quiet", heldQuiet: false },
  { first: "waking", heldQuiet: true },
])(
  "pi-durable harness, a shared run settled by its $first input first",
  ({ heldQuiet }) => {
    it.live(
      "every shared-run scenario passes",
      () =>
        Effect.gen(function* () {
          const target = piDurableTargetWith({
            ...DEFAULT_TOOL_OPTIONS,
            settleDelayMillis: (quiet) =>
              quiet === heldQuiet ? HELD_SETTLE_DELAY_MILLIS : 0,
          });

          const outcomes = yield* Effect.forEach(
            scenarios.filter((scenario) =>
              SHARED_RUN_SCENARIOS.has(scenario.name)
            ),
            (scenario) => runScenario(scenario, target, options),
            { concurrency: 4 }
          );

          assert.strictEqual(outcomes.length, SHARED_RUN_SCENARIOS.size);
          assert.deepStrictEqual(
            outcomes.flatMap((outcome) =>
              Option.match(outcome.failure, {
                onNone: () => [],
                onSome: (failure) => [`${outcome.scenario}: ${failure}`],
              })
            ),
            []
          );
        }),
      120_000
    );
  }
);

/** The side whose record a scenario's golden holds; none while no side passes it. */
const goldenSide = (scenario: Scenario): Option.Option<Side> => {
  if (!PENDING["pi-durable"].has(scenario.name)) {
    return Option.some("pi-durable");
  }

  return PENDING.scripted.has(scenario.name)
    ? Option.none()
    : Option.some("scripted");
};

describe("harness conformance drift", () => {
  it.live(
    "the recorded events and final views match the goldens",
    () =>
      Effect.gen(function* () {
        const update = process.env.CAIRN_UPDATE_GOLDENS === "1";
        const drifted: Array<string> = [];

        for (const scenario of scenarios) {
          const side = goldenSide(scenario);

          if (Option.isNone(side)) {
            continue;
          }

          const outcome = yield* runScenario(
            scenario,
            TARGETS[side.value],
            options
          );

          const file = path.join(here, "goldens", `${scenario.name}.json`);

          if (update) {
            writeFileSync(file, `${JSON.stringify(outcome.record, null, 2)}\n`);
          } else {
            const golden = decodeGolden(readFileSync(file, "utf-8"));

            if (!jsonEquals(golden, outcome.record)) {
              drifted.push(`${scenario.name} (${side.value})`);
            }
          }
        }

        assert.deepStrictEqual(
          drifted,
          [],
          "behaviour changed, review it: compare the scenarios' events and views with goldens/, then rerun with CAIRN_UPDATE_GOLDENS=1"
        );
      }),
    300_000
  );
});

/** The mutation check's per-scenario timeout; the unmutated control runs at it too. */
const MUTATION_TIMEOUT = Duration.millis(1500);

/** Scenarios each broken side must fail, all mutations together and each alone (ADR 0024). */
const GATE = 5;

/** Subagent scenarios each subagent mutation must fail alone (ADR 0028). */
const SUBAGENT_GATE = 2;

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
        }),
        (outcome) => (Option.isSome(outcome.failure) ? [scenario.name] : [])
      ),
    { concurrency: 6 }
  ).pipe(Effect.map((names) => names.flat()));

describe("harness conformance mutation check", () => {
  for (const side of SIDES) {
    const target = TARGETS[side];
    const among = passingOn(side);
    const subagentScenarios = among.filter(isSubagentScenario);

    it.live(
      `a broken ${side} harness fails at least five scenarios`,
      () =>
        Effect.gen(function* () {
          const control = yield* failures(target, among, new Set());

          assert.deepStrictEqual(
            control,
            [],
            "the unmutated harness fails at the mutation check's timeout, so its counts mean nothing"
          );

          const broken = yield* failures(target, among, new Set(MUTATIONS));
          const perMutation: Record<string, number> = {};

          for (const mutation of MUTATIONS) {
            perMutation[mutation] = (yield* failures(
              target,
              among,
              new Set([mutation])
            )).length;
          }

          console.log(
            JSON.stringify({
              side,
              control: control.length,
              failedWithAll: broken.length,
              perMutation,
            })
          );

          assert.isAtLeast(broken.length, GATE);

          for (const mutation of MUTATIONS) {
            assert.isAtLeast(
              perMutation[mutation] ?? 0,
              GATE,
              `${mutation} failed fewer than ${GATE} scenarios`
            );
          }
        }),
      600_000
    );

    it.live.skipIf(subagentScenarios.length === 0)(
      `each subagent mutation fails at least two ${side} subagent scenarios`,
      () =>
        Effect.gen(function* () {
          const control = yield* failures(target, subagentScenarios, new Set());

          assert.deepStrictEqual(
            control,
            [],
            "the unmutated harness fails a subagent scenario at the mutation check's timeout"
          );

          const perMutation: Record<string, ReadonlyArray<string>> = {};

          for (const mutation of SUBAGENT_MUTATIONS) {
            perMutation[mutation] = yield* failures(
              target,
              subagentScenarios,
              new Set([mutation])
            );
          }

          console.log(
            JSON.stringify({
              side,
              subagentScenarios: subagentScenarios.length,
              perMutation,
            })
          );

          for (const mutation of SUBAGENT_MUTATIONS) {
            assert.isAtLeast(
              perMutation[mutation]?.length ?? 0,
              SUBAGENT_GATE,
              `${mutation} failed fewer than ${SUBAGENT_GATE} subagent scenarios`
            );
          }
        }),
      600_000
    );
  }
});
