// The diff fetch stops waiting (T14): a patch the brain never sends fails as `DiffTimedOut` after
// `DIFF_FETCH_TIMEOUT`, which the panel shows as a failure with Retry.
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { DIFF_FETCH_TIMEOUT, patchInTime } from "./Command.ts";

describe("a diff fetch", () => {
  it.effect("that never answers fails once the timeout passes", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.flip(patchInTime(Effect.never))
      );

      yield* TestClock.adjust(
        Duration.sum(DIFF_FETCH_TIMEOUT, Duration.seconds(1))
      );

      const failure = yield* Fiber.join(fiber);

      expect(failure._tag).toBe("DiffTimedOut");
    })
  );
});
