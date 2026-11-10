// A scenario's record (the drift goldens' input) is taken once every thread is at rest, not straight
// after the last line: a client that lags the harness, as one does on a loaded machine, must not
// leave the record short. Each test slows one of the two feeds a run follows, the harness's events
// or the threads' frames, from a chosen event on, and runs a scenario whose last lines wait on the
// other feed, so a record taken as soon as the lines held would miss what the slow feed still had
// to deliver.

import { readFileSync } from "node:fs";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Predicate, Schema, Stream } from "effect";

import type { HarnessEvent, HarnessSeam } from "../HarnessSeam.ts";
import {
  CONFORMANCE_DIR,
  GOLDEN_OPTIONS,
  scenarios,
} from "./ConformanceSuite.ts";
import { runScenario } from "./HarnessConformance.ts";
import { jsonEquals } from "./Normalize.ts";
import { piDurableTarget } from "./Targets.ts";
import type { MakeTarget } from "./Targets.ts";

/**
 * How long a slow feed takes over each element once it is slow: well above the moments between
 * the harness's last steps, well below the suite's timeout over the few elements left.
 */
const STEP = Duration.millis(300);

const decodeGolden = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json)
);

/**
 * `stream` delivering each element `isSlow` names `STEP` after the one before it, in order,
 * without slowing the producer. Once one element is slow, every later one must be too.
 */
const slowing = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  isSlow: (value: A) => boolean
) =>
  stream.pipe(
    Stream.map((value) => ({ value, slow: isSlow(value) })),
    Stream.buffer({ capacity: "unbounded" }),
    Stream.mapEffect(({ value, slow }) =>
      slow ? Effect.as(Effect.sleep(STEP), value) : Effect.succeed(value)
    )
  );

/** A committed message of `role` whose text starts with `text`. */
const isCommitted =
  (role: "user" | "assistant", text: string) => (event: HarnessEvent) =>
    Predicate.isTagged(event, "MessageCommitted") &&
    event.role === role &&
    event.text.startsWith(text);

/**
 * pi-durable with one feed slow from the first event `from` matches on: the events from that one
 * on, or every thread's frames from the moment the runner read it.
 */
const slowTarget =
  (
    feed: "events" | "frames",
    from: (event: HarnessEvent) => boolean
  ): MakeTarget =>
  (script, faults) =>
    Effect.map(piDurableTarget(script, faults), (target) => {
      const state = { slow: false };

      // One wrapper per open instance, as the runner expects of a seam.
      const wrapped = new WeakMap<
        HarnessSeam["Service"],
        HarnessSeam["Service"]
      >();

      const wrap = (seam: HarnessSeam["Service"]) => {
        const existing = wrapped.get(seam);

        if (existing !== undefined) {
          return existing;
        }

        const slow: HarnessSeam["Service"] = {
          ...seam,
          events: slowing(seam.events, (event) => {
            state.slow ||= from(event);

            return feed === "events" && state.slow;
          }),
          watch: (threadId) =>
            slowing(
              seam.watch(threadId),
              () => feed === "frames" && state.slow
            ),
        };

        wrapped.set(seam, slow);

        return slow;
      };

      return { ...target, seam: Effect.map(target.seam, wrap) };
    });

const recordMatchesGolden = (name: string, target: MakeTarget) =>
  Effect.gen(function* () {
    const scenario =
      scenarios.find((found) => found.name === name) ??
      assert.fail(`no scenario ${name}`);

    const outcome = yield* runScenario(scenario, target, GOLDEN_OPTIONS);

    assert.deepStrictEqual(Option.getOrNull(outcome.failure), null);

    const golden = decodeGolden(
      readFileSync(
        path.join(CONFORMANCE_DIR, "goldens", `${name}.json`),
        "utf-8"
      )
    );

    assert.isTrue(
      jsonEquals(golden, outcome.record),
      `the record drifted from its golden: ${JSON.stringify(outcome.record)}`
    );
  });

describe("a scenario's record", () => {
  // The last lines wait on the parent's view, which shows its last answer while the events of it
  // are still coming.
  it.live(
    "holds every event when the events lag the clients' views",
    () =>
      recordMatchesGolden(
        "subagent_send_note_arrives",
        slowTarget("events", isCommitted("assistant", "4 and 9."))
      ),
    30_000
  );

  // The last lines wait on events, and on views of what came before the parent's last run, and
  // the frames of that run are still coming.
  it.live(
    "holds every view when the clients' views lag the events",
    () =>
      recordMatchesGolden(
        "subagent_question_routed_before_user",
        slowTarget(
          "frames",
          isCommitted("user", 'Subagent "Count the files" reported')
        )
      ),
    30_000
  );
});
