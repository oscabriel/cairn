// The goal service over the scripted harness's goals (`ScriptedGoals`): the same rules and the same
// verdict writer as the deployed brain's (`goalBookOver`), a model judge on the model it names, or
// the goal thread's. For the judges' scripted brains; a test double the deployed brain never loads.

import type { ThreadId } from "@cairn/protocol/Ids";
import { Clock, Effect, Layer, Option } from "effect";

import { ScriptedGoals } from "../brain/ScriptedHarness.ts";
import { GoalBook, goalBookOver, missing } from "./GoalBook.ts";
import { applyBind, applyMark } from "./Verdicts.ts";

/** The goal service over the scripted harness's goals. Needs `ScriptedGoals`. */
export const ScriptedGoalBook = Layer.effect(
  GoalBook,
  Effect.gen(function* () {
    const goals = yield* ScriptedGoals;

    /** One change through the verdict writer; a thread gone since it was read is missing. */
    const change = <A>(
      threadId: ThreadId,
      apply: (goal: Parameters<typeof applyBind>[0], at: number) => A
    ) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis;

        const outcome = yield* goals.change(threadId, (goal) =>
          apply(goal, at)
        );

        if (Option.isNone(outcome)) {
          return yield* missing(threadId);
        }

        return outcome.value;
      });

    return goalBookOver<ThreadId>({
      threadOf: (threadId) =>
        Effect.map(goals.thread(threadId), (found) =>
          Option.map(found, (thread) => ({
            key: threadId,
            child: thread.child,
            model: Option.some(thread.model),
          }))
        ),
      resolveJudge: (_threadId, spec) =>
        Effect.succeed(goals.resolveJudge(spec)),
      bind: (threadId, key, input) =>
        change(key, (goal, at) => applyBind(goal, input, at)),
      mark: (input, key) =>
        change(key, (goal, at) =>
          applyMark(goal, {
            criterionId: input.criterionId,
            ok: input.ok,
            note: input.note,
            at,
          })
        ),
    });
  })
);
