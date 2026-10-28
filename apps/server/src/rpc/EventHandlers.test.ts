// `workflow.eventStatus`'s failures: a brain that is reopening or closing and a read the closing
// Harness cut off are `Unavailable`; any other failed read is `Internal`, without pi-durable's text.

import { Internal, Unavailable } from "@cairn/protocol/Errors";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { BrainUnavailable } from "../brain/Brain.ts";
import { DurableCallError } from "../brain/Durable.ts";
import { answerEventStatus } from "./EventHandlers.ts";

const failed = (closed: boolean) =>
  new DurableCallError({
    message: "pi-durable events.status failed: disk I/O error at /secret/path",
    operation: "events.status",
    closed,
    cause: new Error("disk I/O error"),
  });

describe("workflow.eventStatus", () => {
  it.effect("answers the host's status", () =>
    Effect.gen(function* () {
      const status = yield* answerEventStatus(Effect.succeed({ reactors: [] }));

      assert.deepStrictEqual(status, { reactors: [] });
    })
  );

  it.effect("a reopening brain is Unavailable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        answerEventStatus(
          Effect.fail(
            new BrainUnavailable({
              message: "The brain is reopening.",
              state: "reopening",
            })
          )
        )
      );

      assert.instanceOf(error, Unavailable);
      assert.strictEqual(error.message, "The brain is reopening.");
    })
  );

  it.effect("a read cut off by the closing Harness is Unavailable", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        answerEventStatus(Effect.fail(failed(true)))
      );

      assert.instanceOf(error, Unavailable);
    })
  );

  it.effect(
    "any other failed read is Internal, without pi-durable's text",
    () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          answerEventStatus(Effect.fail(failed(false)))
        );

        assert.instanceOf(error, Internal);
        assert.notInclude(error.message, "/secret/path");
        assert.doesNotThrow(() => {
          Schema.encodeUnknownSync(Internal)(error);
        });
      })
  );
});
