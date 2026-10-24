// The root Commands' own rules, apart from the update that issues them.
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { answeredInTime, OUTBOX_SEND_TIMEOUT } from "./Command.ts";

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
