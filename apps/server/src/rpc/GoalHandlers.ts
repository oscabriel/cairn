// The user's goal RPCs (ADR 0026). `goal.setCriteria`: the user binds a thread's objective and
// criteria directly, decided by the user. The goal service refuses what the model's `goal_criteria`
// would (a subagent's thread, a verification judge, a model judge of the thread model's family) as
// `InvalidInput`, naming the field. `goal.mark`: the user's own verdict on a criterion a `user` judge
// decides, recorded by the verdict writer; a criterion the goal does not hold, or one a command or
// model judge decides, is `InvalidInput` on `criterionId`. A thread the brain does not hold is
// `NotFound`; a brain that is down is `Unavailable`.

import {
  Internal,
  InvalidInput,
  NotFound,
  Unavailable,
} from "@cairn/protocol/Errors";
import { CairnRpcs } from "@cairn/protocol/Rpc";
import { Effect, Layer, Match, Option } from "effect";

import { GoalBook } from "../verdicts/GoalBook.ts";
import type { GoalError } from "../verdicts/GoalBook.ts";
import { publicText } from "./PublicText.ts";

/** A goal service failure as the public error a client acts on. */
export const goalErrorOf = (error: GoalError, requestId: string) =>
  Match.value(error.reason).pipe(
    Match.when(
      "thread_not_found",
      () =>
        new NotFound({
          message: publicText(error.message),
          resource: "thread",
          id: error.threadId,
          requestId: Option.some(requestId),
        })
    ),
    Match.when(
      "criterion_not_found",
      () =>
        new InvalidInput({
          message: publicText(error.message),
          field: Option.some("criterionId"),
          requestId: Option.some(requestId),
        })
    ),
    Match.when(
      "invalid_input",
      () =>
        new InvalidInput({
          message: publicText(error.message),
          field: error.field,
          requestId: Option.some(requestId),
        })
    ),
    Match.when(
      "unavailable",
      () =>
        new Unavailable({
          message: publicText(error.message),
          requestId: Option.some(requestId),
        })
    ),
    Match.when(
      "store_failed",
      () =>
        new Internal({
          message: publicText(error.message),
          requestId: Option.some(requestId),
        })
    ),
    Match.exhaustive
  );

/** `goal.setCriteria` and `goal.mark`. Needs `GoalBook`. */
export const GoalHandlers = Layer.mergeAll(
  CairnRpcs.toLayerHandler(
    "goal.setCriteria",
    Effect.gen(function* () {
      const goals = yield* GoalBook;

      return (input, { requestId }) =>
        goals
          .setCriteria(input)
          .pipe(
            Effect.mapError((failed) => goalErrorOf(failed, String(requestId)))
          );
    })
  ),
  CairnRpcs.toLayerHandler(
    "goal.mark",
    Effect.gen(function* () {
      const goals = yield* GoalBook;

      // A mark the writer found already recorded (the same mark again) or stale is no error: the
      // goal document the client watches says where the criterion stands.
      return (input, { requestId }) =>
        goals.mark(input).pipe(
          Effect.asVoid,
          Effect.mapError((failed) => goalErrorOf(failed, String(requestId)))
        );
    })
  )
);
