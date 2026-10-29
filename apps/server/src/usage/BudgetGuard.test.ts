// The budget guard (ADR 0036): on the ledger's changes it stops every thread of a `stop` scope
// at its line once (queues cleared), writes the stopped notice and a raise once and pushes once,
// writes a warning once past the warning line, leaves a `drain` scope's threads running, halts
// instead of stopping at boot (so nothing resumes scheduling before the Harness does), and re-reads
// a scope when its raise is answered.

import { ApprovalId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, PubSub, Ref, Result } from "effect";

import { RuntimeRequestUpdated } from "../brain/HarnessSeam.ts";
import { FREE_KEY, SpendScript, usageOf } from "../brain/SpendTestKit.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import type { BudgetMode } from "./BudgetBook.ts";
import { BudgetGuard } from "./BudgetGuard.ts";
import { Budgets } from "./Budgets.ts";
import {
  GuardScript,
  GuardWorld,
  settle,
  SourcesScript,
  tokenBudget,
  withThreads,
} from "./BudgetTestKit.ts";

const ROOT = testThreadId(1);

const CHILD = testThreadId(2);

const GRANDCHILD = testThreadId(3);

/** Puts a scope in the in-memory documents and loads the book, as boot does. */
const scope = (tokens: number, mode: BudgetMode, epoch = 0) =>
  Effect.gen(function* () {
    const script = yield* SourcesScript;

    yield* Ref.update(script.scopes, (map) =>
      new Map(map).set(CHILD, {
        threadId: CHILD,
        budget: tokenBudget(tokens),
        mode,
        epoch,
      })
    );
  });

const spend = (conversation: number, thread: typeof ROOT, tokens: number) =>
  Effect.gen(function* () {
    const feed = yield* SpendScript;

    yield* feed.commit(conversation, Option.some(thread), {
      responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: tokens }) }],
    });
    yield* settle;
  });

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

describe("the budget guard", () => {
  it.live(
    "stops every thread of a stop scope once at its line, with one notice, one raise and one push",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 2],
        ]);
        yield* scope(100, "stop");
        yield* (yield* Budgets).load;

        const guard = yield* GuardScript;
        const sources = yield* SourcesScript;

        yield* spend(2, CHILD, 50);
        yield* spend(3, GRANDCHILD, 40);

        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(sources.notices), (map) => map.size === 1)
          )
        );
        assert.deepStrictEqual(
          [...(yield* Ref.get(sources.notices)).keys()],
          [`${CHILD} budget-warning-0`]
        );
        assert.deepStrictEqual(yield* Ref.get(guard.stops), []);

        yield* spend(3, GRANDCHILD, 20);

        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(guard.stops), (stops) => stops.length === 2)
          )
        );

        // More spend after the line changes nothing.
        yield* spend(2, CHILD, 30);
        yield* Effect.sleep(Duration.millis(100));

        const stops = yield* Ref.get(guard.stops);

        assert.deepStrictEqual(
          stops.map((stop) => stop.threadId).toSorted(),
          [CHILD, GRANDCHILD].toSorted()
        );
        assert.isTrue(stops.every((stop) => stop.options.clearQueue));

        const notices = yield* Ref.get(sources.notices);
        const stopped = notices.get(`${CHILD} budget-stopped-0`);

        assert.strictEqual(notices.size, 2);
        assert.strictEqual(stopped?.reason, "budget_stopped");
        assert.include(stopped?.text ?? "", "stopped at 110 of 100 tokens");

        assert.deepStrictEqual(
          [...(yield* Ref.get(sources.raises))].map(([key, to]) => [
            key,
            to.maxTokens,
          ]),
          [[`${CHILD} 0`, 200]]
        );

        const pushes = yield* Ref.get(guard.pushes);

        assert.strictEqual(pushes.length, 2);
        assert.strictEqual(pushes[1]?.url, `/t/${CHILD}`);
        assert.deepStrictEqual(yield* Ref.get(sources.halted), []);
      }).pipe(Effect.provide(GuardWorld))
  );

  it.live("a drain scope at its line stops nothing and says so once", () =>
    Effect.gen(function* () {
      yield* withThreads([[2, 1]]);
      yield* scope(100, "drain");
      yield* (yield* Budgets).load;

      const guard = yield* GuardScript;
      const sources = yield* SourcesScript;

      yield* spend(2, CHILD, 150);

      assert.isTrue(
        yield* eventually(
          Effect.map(Ref.get(sources.notices), (map) =>
            map.has(`${CHILD} budget-stopped-0`)
          )
        )
      );
      assert.deepStrictEqual(yield* Ref.get(guard.stops), []);
      assert.include(
        (yield* Ref.get(sources.notices)).get(`${CHILD} budget-stopped-0`)
          ?.text ?? "",
        "no new subagent work starts here"
      );
    }).pipe(Effect.provide(GuardWorld))
  );

  it.live(
    "at boot it halts a stopped scope's threads without the seam, and a raise answered lets work start",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 2],
        ]);
        yield* spend(2, CHILD, 150);
        yield* scope(100, "stop");

        const budgets = yield* Budgets;
        const guard = yield* GuardScript;
        const sources = yield* SourcesScript;

        yield* (yield* BudgetGuard).boot;

        assert.deepStrictEqual(
          (yield* Ref.get(sources.halted)).map((call) => [...call].toSorted()),
          [[CHILD, GRANDCHILD].toSorted()]
        );
        assert.deepStrictEqual(yield* Ref.get(guard.stops), []);
        assert.isTrue(
          (yield* Ref.get(sources.notices)).has(`${CHILD} budget-stopped-0`)
        );
        assert.strictEqual((yield* Ref.get(guard.pushes)).length, 1);

        const refused = yield* Effect.flip(budgets.admit(GRANDCHILD));

        assert.strictEqual(refused.scope, CHILD);

        // The user accepts the raise: the documents now hold the raised budget at epoch 1.
        yield* scope(200, "stop", 1);
        yield* PubSub.publish(
          guard.events,
          RuntimeRequestUpdated.make({
            threadId: CHILD,
            id: ApprovalId.make("budget-raise-0"),
            kind: "tool-call",
            status: "accepted",
          })
        );

        assert.isTrue(
          yield* eventually(
            Effect.map(
              Effect.result(budgets.admit(GRANDCHILD)),
              Result.isSuccess
            )
          )
        );
        assert.isTrue(
          Option.isNone(yield* budgets.gate(CHILD, "bash", Option.none()))
        );
      }).pipe(Effect.provide(GuardWorld))
  );
});
