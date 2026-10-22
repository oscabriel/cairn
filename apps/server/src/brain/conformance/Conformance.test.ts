// The harness seam's outside judge (ADR 0024): every scenario's hand-written expectations against
// both harnesses, the drift goldens on the pi-durable side, and the mutation check, which wraps
// each harness in a broken seam and requires the suite to fail at least five scenarios on each
// side. Set CAIRN_UPDATE_GOLDENS=1 to rewrite the goldens after reviewing a behaviour change.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Result, Schema } from "effect";

import {
  registerHarnessConformance,
  runScenario,
} from "./HarnessConformance.ts";
import type { Mutation } from "./Mutations.ts";
import { MUTATIONS } from "./Mutations.ts";
import { jsonEquals } from "./Normalize.ts";
import { piDurableTarget, scriptedTarget } from "./Targets.ts";
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
  scenarios,
  options
);

registerHarnessConformance(
  runner,
  "scripted harness",
  scriptedTarget,
  scenarios,
  options
);

describe("harness conformance drift", () => {
  it.live(
    "pi-durable's recorded events and final views match the goldens",
    () =>
      Effect.gen(function* () {
        const update = process.env.CAIRN_UPDATE_GOLDENS === "1";
        const drifted: Array<string> = [];

        for (const scenario of scenarios) {
          const outcome = yield* runScenario(
            scenario,
            piDurableTarget,
            options
          );

          const file = path.join(here, "goldens", `${scenario.name}.json`);

          if (update) {
            writeFileSync(file, `${JSON.stringify(outcome.record, null, 2)}\n`);
          } else {
            const golden = decodeGolden(readFileSync(file, "utf-8"));

            if (!jsonEquals(golden, outcome.record)) {
              drifted.push(scenario.name);
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

const failures = (
  target: typeof piDurableTarget,
  mutations: ReadonlySet<Mutation>
) =>
  Effect.forEach(
    scenarios,
    (scenario) =>
      Effect.map(
        runScenario(scenario, target, {
          timeout: Duration.millis(1500),
          mutations,
        }),
        (outcome) => (Option.isSome(outcome.failure) ? [scenario.name] : [])
      ),
    { concurrency: 6 }
  ).pipe(Effect.map((names) => names.flat()));

describe("harness conformance mutation check", () => {
  for (const [side, target] of [
    ["pi-durable", piDurableTarget],
    ["scripted", scriptedTarget],
  ] as const) {
    it.live(
      `a broken ${side} harness fails at least five scenarios`,
      () =>
        Effect.gen(function* () {
          const broken = yield* failures(target, new Set(MUTATIONS));
          const perMutation: Record<string, number> = {};

          for (const mutation of MUTATIONS) {
            perMutation[mutation] = (yield* failures(
              target,
              new Set([mutation])
            )).length;
          }

          console.log(
            JSON.stringify({ side, failedWithAll: broken.length, perMutation })
          );

          assert.isAtLeast(broken.length, 5);

          for (const mutation of MUTATIONS) {
            assert.isAtLeast(
              perMutation[mutation] ?? 0,
              1,
              `${mutation} was not caught`
            );
          }
        }),
      600_000
    );
  }
});
