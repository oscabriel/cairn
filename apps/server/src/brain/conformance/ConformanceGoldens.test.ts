// The conformance suite's drift goldens (ADR 0024): each scenario's recorded events and final
// views against `goldens/`, and the brief expiry scenarios, which run on both harnesses with a
// short brief lifetime and match their goldens too. See `ConformanceSuite.ts` for the judge's
// other parts. Set CAIRN_UPDATE_GOLDENS=1 to rewrite the goldens after reviewing a behaviour change.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";

import { testLimit } from "../../EventuallyTestKit.ts";
import { DEFAULT_TOOL_OPTIONS } from "../../subagents/SubagentTools.ts";
import {
  allScenarios,
  BRIEF_EXPIRY_SCENARIOS,
  CONFORMANCE_DIR,
  GOLDEN_OPTIONS,
  PENDING,
  scenarios,
  SHORT_BRIEF_TTL_MILLIS,
  SIDES,
  TARGETS,
} from "./ConformanceSuite.ts";
import type { Side } from "./ConformanceSuite.ts";
import { runScenario } from "./HarnessConformance.ts";
import { jsonEquals } from "./Normalize.ts";
import { piDurableTargetWith, scriptedTargetWith } from "./Targets.ts";
import type { MakeTarget } from "./Targets.ts";
import type { Scenario } from "./Transcript.ts";

const decodeGolden = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json)
);

const goldenFile = (scenario: Scenario) =>
  path.join(CONFORMANCE_DIR, "goldens", `${scenario.name}.json`);

// A pending brief expires after its lifetime and its parent is told (ADR 0030); a Go after that
// starts nothing. Both sides run with a one-second lifetime, and pi-durable's record is the golden.
describe("brief expiry, with a short brief lifetime", () => {
  const expiryTargets: Readonly<Record<Side, MakeTarget>> = {
    "pi-durable": piDurableTargetWith({
      ...DEFAULT_TOOL_OPTIONS,
      briefTtlMillis: SHORT_BRIEF_TTL_MILLIS,
    }),
    scripted: scriptedTargetWith(SHORT_BRIEF_TTL_MILLIS),
  };

  it.live(
    "every expiry scenario passes on both harnesses and matches its golden",
    () =>
      Effect.gen(function* () {
        const expiry = allScenarios.filter((scenario) =>
          BRIEF_EXPIRY_SCENARIOS.has(scenario.name)
        );

        assert.strictEqual(expiry.length, BRIEF_EXPIRY_SCENARIOS.size);

        const failed: Array<string> = [];

        for (const side of SIDES) {
          for (const scenario of expiry) {
            const outcome = yield* runScenario(
              scenario,
              expiryTargets[side],
              GOLDEN_OPTIONS
            );

            for (const failure of Option.toArray(outcome.failure)) {
              failed.push(`${side} ${scenario.name}: ${failure}`);
            }

            // A failed run's record is never judged or written: it may stop short.
            if (side !== "pi-durable" || Option.isSome(outcome.failure)) {
              continue;
            }

            const file = goldenFile(scenario);

            if (process.env.CAIRN_UPDATE_GOLDENS === "1") {
              writeFileSync(
                file,
                `${JSON.stringify(outcome.record, null, 2)}\n`
              );
            } else if (
              !jsonEquals(
                decodeGolden(readFileSync(file, "utf-8")),
                outcome.record
              )
            ) {
              failed.push(`${scenario.name}: drifted from its golden`);
            }
          }
        }

        assert.deepStrictEqual(failed, []);
      }),
    testLimit(120_000)
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
        const failed: Array<string> = [];
        const drifted: Array<string> = [];

        for (const scenario of scenarios) {
          const side = goldenSide(scenario);

          if (Option.isNone(side)) {
            continue;
          }

          const outcome = yield* runScenario(
            scenario,
            TARGETS[side.value],
            GOLDEN_OPTIONS
          );

          const file = goldenFile(scenario);

          // A failed run's record is never judged or written: it may stop short.
          if (Option.isSome(outcome.failure)) {
            failed.push(
              `${scenario.name} (${side.value}): ${outcome.failure.value}`
            );
          } else if (update) {
            writeFileSync(file, `${JSON.stringify(outcome.record, null, 2)}\n`);
          } else {
            const golden = decodeGolden(readFileSync(file, "utf-8"));

            if (!jsonEquals(golden, outcome.record)) {
              drifted.push(`${scenario.name} (${side.value})`);
            }
          }
        }

        assert.deepStrictEqual(
          failed,
          [],
          "these runs failed, so their records were neither judged nor written"
        );
        assert.deepStrictEqual(
          drifted,
          [],
          "behaviour changed, review it: compare the scenarios' events and views with goldens/, then rerun with CAIRN_UPDATE_GOLDENS=1"
        );
      }),
    testLimit(300_000)
  );
});
