// The root Commands' own rules, apart from the update that issues them.

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { answeredInTime, OUTBOX_SEND_TIMEOUT } from "./Command.ts";
import {
  BRAIN_INTERNAL_TEXT,
  CUT_OFF_TEXT,
  withBoundary,
} from "./connection/Connection.ts";
import { isRetryable, isTransport } from "./connection/Failure.ts";

describe("an outbox send", () => {
  it.effect(
    "that the brain never answers fails as retryable once the timeout passes",
    () =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.flip(answeredInTime(Effect.never))
        );

        yield* TestClock.adjust(
          Duration.sum(OUTBOX_SEND_TIMEOUT, Duration.seconds(1))
        );

        const failure = yield* Fiber.join(fiber);

        expect([failure._tag, failure.retryable]).toStrictEqual([
          "OutboxSendTimeout",
          true,
        ]);
      })
  );
});

describe("the client boundary", () => {
  it.effect(
    "turns a defect from the brain into a failure no retry will fix",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          withBoundary(Effect.die(new Error("undecodable answer")))
        );

        expect([
          failure._tag,
          isRetryable(failure),
          failure.message,
        ]).toStrictEqual(["Internal", false, BRAIN_INTERNAL_TEXT]);
      })
  );

  it.effect(
    "turns a call cut off by a dropped connection into a transport failure, not an interruption",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(withBoundary(Effect.interrupt));

        expect([
          failure._tag,
          isTransport(failure),
          isRetryable(failure),
          failure.message,
        ]).toStrictEqual(["CutOff", true, true, CUT_OFF_TEXT]);
      })
  );

  it.effect("leaves the call's own failure as it is", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        withBoundary(Effect.fail({ _tag: "Refused" as const }))
      );

      expect(failure._tag).toBe("Refused");
    })
  );
});
