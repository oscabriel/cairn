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

import {
  registerHarnessConformance,
  runScenario,
} from "./HarnessConformance.ts";
import type { Mutation } from "./Mutations.ts";
import { MUTATIONS, SUBAGENT_MUTATIONS } from "./Mutations.ts";
import { jsonEquals } from "./Normalize.ts";
import { piDurableTarget, scriptedTarget } from "./Targets.ts";
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
 * Scenarios each side does not pass yet. pi-durable passes the subagent groups once its subagents
 * extension lands; the scripted harness models them now.
 *
 * Two windows of the subagents note's groups are judged elsewhere. `subagent_result_once_with_crash`
 * crashes while the child's answer and the parent's woken run are held; the scripted reporter
 * settles and reports in single critical sections a crash line cannot split, so the windows
 * between the child's answer, the settlement and the report belong to 4C's
 * `judges/subagent-durability.ts`. `subagent_brief_declined` covers declined and revised briefs;
 * an expired brief (group 2's third case) belongs to 4A, which owns expiry.
 */
const subagentNames = scenarios.flatMap((scenario) =>
  isSubagentScenario(scenario) ? [scenario.name] : []
);

const PENDING: Readonly<Record<Side, ReadonlySet<string>>> = {
  "pi-durable": new Set(subagentNames),
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

/** The timeout a pending scenario runs at: it is expected to fail, so it need not wait long. */
const PENDING_TIMEOUT = Duration.millis(1500);

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
            runScenario(scenario, TARGETS[side], {
              ...options,
              timeout: PENDING_TIMEOUT,
            }),
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
