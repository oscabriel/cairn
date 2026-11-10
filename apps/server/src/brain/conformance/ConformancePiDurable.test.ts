// The conformance suite (ADR 0024) on the pi-durable harness: every scenario it passes, every
// scenario still pending on it failing, and the shared runs settled in each order. See
// `ConformanceSuite.ts` for the judge's other parts.

import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { TEST_SLACK } from "../../EventuallyTestKit.ts";
import { DEFAULT_TOOL_OPTIONS } from "../../subagents/SubagentTools.ts";
import { registerSide, scenarios, SUITE_OPTIONS } from "./ConformanceSuite.ts";
import { runScenario } from "./HarnessConformance.ts";
import { piDurableTargetWith } from "./Targets.ts";

registerSide({ describe, it }, "pi-durable");

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
            (scenario) => runScenario(scenario, target, SUITE_OPTIONS),
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
      120_000 * TEST_SLACK
    );
  }
);
