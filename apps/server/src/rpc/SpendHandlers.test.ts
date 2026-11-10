// `budget.declare` (ADR 0047) over the budget guard's test world (`BudgetTestKit.ts`: the real book,
// ledger, `Budgets` and guard, in-memory sources, a seam that records stops): a thread budget the
// user sets stops the thread and its subtree at its line, as a brief's budget does, and asks a
// raise; a thread the shell does not hold is `NotFound`.

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, Predicate, Ref, Result } from "effect";

import { FREE_KEY, SpendScript, usageOf } from "../brain/SpendTestKit.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetGuard } from "../usage/BudgetGuard.ts";
import {
  GuardScript,
  GuardWorld,
  settle,
  SourcesScript,
  tokenBudget,
  withThreads,
} from "../usage/BudgetTestKit.ts";
import { declareBudget } from "./SpendHandlers.ts";

const ROOT = testThreadId(1);

const CHILD = testThreadId(2);

/** Waits (up to two seconds) until `check` holds. */
const eventually = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 100; tries += 1) {
      if (yield* check) {
        return true;
      }

      yield* Effect.sleep(Duration.millis(20));
    }

    return false;
  });

const declare = (threadId: typeof ROOT, tokens: number) =>
  Effect.gen(function* () {
    return yield* declareBudget(yield* BudgetGuard, yield* ThreadRows, {
      threadId,
      budget: tokenBudget(tokens),
    }).pipe(Effect.result);
  });

describe("budget.declare", () => {
  it.live(
    "a thread budget the user sets stops the thread and its subtree at its line, and asks a raise",
    () =>
      Effect.gen(function* () {
        yield* withThreads([[2, 1]]);

        const declared = yield* declare(ROOT, 100);

        assert.isTrue(Result.isSuccess(declared), JSON.stringify(declared));

        const guard = yield* GuardScript;
        const sources = yield* SourcesScript;
        const feed = yield* SpendScript;

        // Under the line nothing stops.
        yield* feed.commit(2, Option.some(CHILD), {
          responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: 60 }) }],
        });
        yield* settle;
        assert.deepStrictEqual(yield* Ref.get(guard.stops), []);

        // The child's next response crosses the root's line: both stop, once, and a raise is asked.
        yield* feed.commit(2, Option.some(CHILD), {
          responses: [
            { modelKey: FREE_KEY, usage: usageOf({ input: 60 }) },
            { modelKey: FREE_KEY, usage: usageOf({ input: 60 }) },
          ],
        });
        yield* settle;

        assert.isTrue(
          yield* eventually(
            // The declare is the scope's first epoch.
            Effect.map(Ref.get(sources.raises), (raises) =>
              raises.has(`${ROOT} 1`)
            )
          ),
          "no raise was asked"
        );
        assert.deepStrictEqual(
          (yield* Ref.get(guard.stops)).map((stop) => stop.threadId).toSorted(),
          [ROOT, CHILD].toSorted()
        );
        assert.isTrue(
          (yield* Ref.get(sources.notices)).has(`${ROOT} budget-stopped-1`)
        );
      }).pipe(Effect.provide(GuardWorld))
  );

  it.live(
    "a thread the shell does not hold is NotFound, and nothing is declared",
    () =>
      Effect.gen(function* () {
        yield* withThreads([]);

        const declared = yield* declare(testThreadId(9), 100);

        assert.isTrue(
          Result.isFailure(declared) &&
            Predicate.isTagged(declared.failure, "NotFound"),
          JSON.stringify(declared)
        );
        assert.strictEqual(
          (yield* Ref.get((yield* SourcesScript).scopes)).size,
          0
        );
      }).pipe(Effect.provide(GuardWorld))
  );
});
