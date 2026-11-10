// A subagent's wake over pi-durable with a held wake (ADR 0028): the scenarios in
// `conformance/tuned/`, run on the pi-durable side only, since the scripted reporter decides a wake
// and admits it in one critical section that nothing can split.
//
// - `two_children_one_wake`: two children settle together while their parent runs. The first
//   reporter's wake is held between its decision and its submit, and the second reporter still
//   leaves the waking to it: the parent gets one wake.
// - `wake_after_parent_stop`: a reporter decides to wake its running parent, and the user stops
//   the parent while the wake is held. The parent is not woken: it does not run again.
// - `wake_after_idle_wake`: the parent is idle, so the first child's wake starts its run at once,
//   and its reporter is held after that submit. A second child settles while that run goes on: its
//   reporter does not leave the waking to a wake already submitted, so the parent runs again.
// - `tell_after_parent_stop`: the user declines a brief while the parent is idle, then stops the
//   parent while the tell is held before its submit. The tell lands as a note: the parent does not
//   run again.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Result } from "effect";

import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import { runScenario } from "./conformance/HarnessConformance.ts";
import { piDurableTargetWith } from "./conformance/Targets.ts";
import { parseTranscript } from "./conformance/Transcript.ts";

const here = path.join(import.meta.dirname, "conformance", "tuned");

/** How long a reporter holds a wake it decided on: long enough to land a stop or a second child. */
const WAKE_DELAY_MILLIS = 300;

/** How long a reporter that submitted its wake holds before it ends, in `wake_after_idle_wake`. */
const WOKEN_DELAY_MILLIS = 1500;

/** Runs `tuned/<name>.ndjson` on pi-durable with held wakes, failing the test with its failure. */
const passes = (name: string, wokenDelayMillis = 0) =>
  Effect.gen(function* () {
    const scenario = Result.getOrThrow(
      parseTranscript(readFileSync(path.join(here, `${name}.ndjson`), "utf-8"))
    );

    const outcome = yield* runScenario(
      scenario,
      piDurableTargetWith({
        ...DEFAULT_TOOL_OPTIONS,
        wakeDelayMillis: WAKE_DELAY_MILLIS,
        wokenDelayMillis,
      }),
      { timeout: Duration.seconds(5), mutations: new Set(), awaitAtRest: false }
    );

    assert.deepStrictEqual(outcome.failure, Option.none());
  });

describe("a subagent's wake, held before its submit", () => {
  it.live(
    "two children settling together while their parent runs queue one wake",
    () => passes("two_children_one_wake"),
    30_000
  );

  it.live(
    "a wake decided before the user stopped the parent does not start it again",
    () => passes("wake_after_parent_stop"),
    30_000
  );

  it.live(
    "a declined brief's tell held past the user's stop does not start the parent again",
    () => passes("tell_after_parent_stop"),
    30_000
  );

  it.live(
    "a child settling while another child's wake runs its idle parent wakes the parent again",
    () => passes("wake_after_idle_wake", WOKEN_DELAY_MILLIS),
    30_000
  );
});
