// `budget.declare` (ADR 0047) over the budget guard's test world (`BudgetTestKit.ts`: the real book,
// ledger, `Budgets` and guard, in-memory sources, a seam that records stops): a thread budget the
// user sets stops the thread and its subtree at its line, as a brief's budget does, and asks a
// raise; a thread the shell does not hold is `NotFound`. `budget.get` reads the line a declare would
// replace, so the form that changes it starts from it.

import { DEFAULT_BUDGET } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Predicate, Ref, Result } from "effect";

import { FREE_KEY, SpendScript, usageOf } from "../brain/SpendTestKit.ts";
import { eventuallyTrue as eventually } from "../EventuallyTestKit.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { BudgetGuard } from "./BudgetGuard.ts";
import {
  GuardScript,
  GuardWorld,
  settle,
  SourcesScript,
  tokenBudget,
  withThreads,
} from "./BudgetTestKit.ts";
import { declareBudget, readBudget } from "./SpendHandlers.ts";

const ROOT = testThreadId(1);

const CHILD = testThreadId(2);

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

const read = (threadId: typeof ROOT) =>
  Effect.gen(function* () {
    return yield* readBudget(yield* BudgetGuard, yield* ThreadRows, {
      threadId,
    }).pipe(Effect.result);
  });

describe("budget.get", () => {
  it.live(
    "reads the line a thread's own scope stands at, none before one is set or after it is removed",
    () =>
      Effect.gen(function* () {
        yield* withThreads([[2, 1]]);

        assert.deepStrictEqual(
          yield* read(ROOT),
          Result.succeed({ budget: Option.none() })
        );

        yield* declare(ROOT, 100);

        assert.deepStrictEqual(
          yield* read(ROOT),
          Result.succeed({ budget: Option.some(tokenBudget(100)) })
        );

        // The child has no line of its own: the root's binds it.
        assert.deepStrictEqual(
          yield* read(CHILD),
          Result.succeed({ budget: Option.none() })
        );

        const removed = yield* declareBudget(
          yield* BudgetGuard,
          yield* ThreadRows,
          { threadId: ROOT, budget: DEFAULT_BUDGET }
        ).pipe(Effect.result);

        assert.isTrue(Result.isSuccess(removed), JSON.stringify(removed));
        assert.deepStrictEqual(
          yield* read(ROOT),
          Result.succeed({ budget: Option.none() })
        );
      }).pipe(Effect.provide(GuardWorld))
  );

  it.live("a thread the shell does not hold is NotFound", () =>
    Effect.gen(function* () {
      yield* withThreads([]);

      const found = yield* read(testThreadId(9));

      assert.isTrue(
        Result.isFailure(found) &&
          Predicate.isTagged(found.failure, "NotFound"),
        JSON.stringify(found)
      );
    }).pipe(Effect.provide(GuardWorld))
  );
});
