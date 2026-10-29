// A child's question to its parent over pi-durable with short timings (ADR 0027): the scenarios in
// `conformance/tuned/`, run on the pi-durable side only, since the scripted harness has no question
// window and a fixed expiry.
//
// - `relay_asks_twice`: a child's final answers ask twice in one run's reporter, the second past
//   the first one's window. Each question's window starts at its own placement, so the parent's
//   model answers the second within it (the window's memo is named per question).
// - `relay_expires`: a question a child's final answer became, escalated and left unanswered,
//   expires at its expiry: its record, the parent's mirror and the escalation entry end, and the
//   run's own answer settles once.
// - `relay_window_across_restart` and `ask_parent_window_across_restart`: the brain closes and
//   reopens while the parent's model holds a question, and the question escalates at its original
//   placement plus the window, not a window after the restart: the reporter's memo and the tool
//   call's memo keep the placement.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Result } from "effect";

import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../subagents/SubagentTools.ts";
import { runScenario } from "./conformance/HarnessConformance.ts";
import { piDurableTargetWith } from "./conformance/Targets.ts";
import { parseTranscript } from "./conformance/Transcript.ts";

const here = path.join(import.meta.dirname, "conformance", "tuned");

/** The parent's questions' window in the two-question case; its second question comes 2.5 s on. */
const TWICE_WINDOW_MILLIS = 1500;

/** A relayed question's lifetime in the expiry case. */
const RELAY_TTL_MILLIS = 800;

/** The window in the restart cases: the scenario says "within 5 seconds". */
const RESTART_WINDOW_MILLIS = 4500;

/**
 * How long an expectation may wait in the restart cases. The parent's model held the question 2 s
 * before the brain closed, so the escalation comes within it after the restart at the original
 * placement plus the window, and does not when the window starts again with the brain.
 */
const RESTART_TIMEOUT = Duration.millis(3000);

/** Runs `tuned/<name>.ndjson` on pi-durable with `tuning`, failing the test with its failure. */
const passes = (
  name: string,
  tuning: Partial<SubagentToolOptions>,
  timeout = Duration.seconds(5)
) =>
  Effect.gen(function* () {
    const scenario = Result.getOrThrow(
      parseTranscript(readFileSync(path.join(here, `${name}.ndjson`), "utf-8"))
    );

    const outcome = yield* runScenario(
      scenario,
      piDurableTargetWith({ ...DEFAULT_TOOL_OPTIONS, ...tuning }),
      { timeout, mutations: new Set() }
    );

    assert.deepStrictEqual(outcome.failure, Option.none());
  });

describe("a child's question to its parent, with short timings", () => {
  it.live(
    "a reporter that relays two questions gives each its own window",
    () =>
      passes("relay_asks_twice", { questionWindowMillis: TWICE_WINDOW_MILLIS }),
    30_000
  );

  it.live(
    "a relayed question nobody answers expires, and the run's own answer settles once",
    () => passes("relay_expires", { questionTtlMillis: RELAY_TTL_MILLIS }),
    30_000
  );

  it.live(
    "a relayed question's window keeps its placement across a restart",
    () =>
      passes(
        "relay_window_across_restart",
        { questionWindowMillis: RESTART_WINDOW_MILLIS },
        RESTART_TIMEOUT
      ),
    30_000
  );

  it.live(
    "an ask_parent question's window keeps its placement across a restart",
    () =>
      passes(
        "ask_parent_window_across_restart",
        { questionWindowMillis: RESTART_WINDOW_MILLIS },
        RESTART_TIMEOUT
      ),
    30_000
  );
});
