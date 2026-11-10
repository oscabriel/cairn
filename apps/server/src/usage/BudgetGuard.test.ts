// The budget guard (ADR 0036): on the ledger's changes it stops every thread of a `stop` scope
// at its line once (queues cleared), writes the stopped notice and a raise once and pushes once,
// writes a warning once past the warning line, leaves a `drain` scope's threads running, halts
// instead of stopping at boot (so nothing resumes scheduling before the Harness does), and re-reads
// a scope when its raise is answered. A raise accepted that leaves the scope at its line is a new
// epoch at the line, acted on again, and a scope declared past its line is acted on whether or not
// the caller passed its transitions on. A step that fails drops no other scope's warning, and the
// failed scope is acted on by a later pass with no new spend under it, one the guard starts itself
// after its retry wait (on the test clock), even when a pass in between could not read a scope.

import { ApprovalId } from "@cairn/protocol/Ids";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Option, PubSub, Ref, Result } from "effect";
import { TestClock } from "effect/testing";

import { RuntimeRequestUpdated } from "../brain/HarnessSeam.ts";
import { FREE_KEY, SpendScript, usageOf } from "../brain/SpendTestKit.ts";
import {
  eventuallyTrue as eventually,
  slackenedTries,
} from "../EventuallyTestKit.ts";
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

/**
 * Moves the test clock in 20 ms steps, up to two seconds scaled by the test slack, until `check`
 * holds.
 */
const eventuallyOnClock = <R>(check: Effect.Effect<boolean, never, R>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < slackenedTries(100); tries += 1) {
      if (yield* check) {
        return true;
      }

      yield* TestClock.adjust(Duration.millis(20));
    }

    return false;
  });

/**
 * On the test clock: the child's scope stops at 100 tokens, spend reaches it, and writing its
 * stopped notice fails, so the guard leaves the scope to retry.
 */
const childStepFails = Effect.gen(function* () {
  yield* withThreads([
    [2, 1],
    [3, 2],
  ]);
  yield* scope(100, "stop");
  yield* (yield* Budgets).load;

  const sources = yield* SourcesScript;
  const feed = yield* SpendScript;

  yield* Ref.set(sources.failNotices, new Set([`${CHILD} budget-stopped-0`]));
  yield* feed.commit(3, Option.some(GRANDCHILD), {
    responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: 110 }) }],
  });

  assert.isTrue(
    yield* eventuallyOnClock(
      Effect.map(Ref.get(sources.failNotices), (failing) => failing.size === 0)
    ),
    "the stopped notice was never tried"
  );
  assert.isFalse((yield* Ref.get(sources.raises)).has(`${CHILD} 0`));
});

const raiseAsked = Effect.gen(function* () {
  const sources = yield* SourcesScript;

  return (yield* Ref.get(sources.raises)).has(`${CHILD} 0`);
});

describe("the budget guard's retry", () => {
  it.effect(
    "starts a pass for a failed scope once the retry wait passes, with no new spend",
    () =>
      Effect.gen(function* () {
        yield* childStepFails;

        yield* TestClock.adjust(Duration.seconds(25));
        assert.isFalse(yield* raiseAsked, "retried before the wait passed");

        yield* TestClock.adjust(Duration.seconds(5));
        assert.isTrue(yield* eventuallyOnClock(raiseAsked));
      }).pipe(Effect.provide(GuardWorld))
  );

  it.effect(
    "keeps the scopes a pass was retrying when that pass cannot read a scope",
    () =>
      Effect.gen(function* () {
        yield* childStepFails;

        const sources = yield* SourcesScript;
        const guard = yield* GuardScript;

        // A raise answered elsewhere starts a pass, and its re-read fails before any evaluation.
        yield* Ref.set(sources.failScopeReads, 1);
        yield* PubSub.publish(
          guard.events,
          RuntimeRequestUpdated.make({
            threadId: ROOT,
            id: ApprovalId.make("budget-raise-0"),
            kind: "tool-call",
            status: "accepted",
          })
        );

        assert.isTrue(
          yield* eventuallyOnClock(
            Effect.map(Ref.get(sources.failScopeReads), (left) => left === 0)
          ),
          "the pass never read the scope"
        );

        yield* TestClock.adjust(Duration.seconds(31));
        assert.isTrue(yield* eventuallyOnClock(raiseAsked));
      }).pipe(Effect.provide(GuardWorld))
  );

  it.effect(
    "reads a scope again after the retry wait when the pass that came for it cannot read it",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 2],
        ]);
        yield* scope(100, "stop");
        yield* (yield* Budgets).load;

        const sources = yield* SourcesScript;
        const guard = yield* GuardScript;
        const feed = yield* SpendScript;

        yield* feed.commit(3, Option.some(GRANDCHILD), {
          responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: 110 }) }],
        });
        assert.isTrue(yield* eventuallyOnClock(raiseAsked), "no first raise");

        // The raise is accepted but leaves the scope at its line, so a new epoch needs a new raise;
        // the pass that re-reads the scope for it fails that read.
        yield* scope(100, "stop", 1);
        yield* Ref.set(sources.failScopeReads, 1);
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
          yield* eventuallyOnClock(
            Effect.map(Ref.get(sources.failScopeReads), (left) => left === 0)
          ),
          "the pass never read the scope"
        );

        const raisedAgain = Effect.map(Ref.get(sources.raises), (raises) =>
          raises.has(`${CHILD} 1`)
        );

        yield* TestClock.adjust(Duration.seconds(31));
        assert.isTrue(yield* eventuallyOnClock(raisedAgain));
      }).pipe(Effect.provide(GuardWorld))
  );
});

describe("the budget guard", () => {
  it.live(
    "acts on every scope of a pass when one step fails, and on the failed one again later",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 2],
        ]);

        const sources = yield* SourcesScript;

        // The child's scope stops at 100 tokens; the root's warns at 104 of 130.
        yield* Ref.set(
          sources.scopes,
          new Map([
            [
              CHILD,
              {
                threadId: CHILD,
                budget: tokenBudget(100),
                mode: "stop" as const,
                epoch: 0,
              },
            ],
            [
              ROOT,
              {
                threadId: ROOT,
                budget: tokenBudget(130),
                mode: "stop" as const,
                epoch: 0,
              },
            ],
          ])
        );
        yield* (yield* Budgets).load;

        yield* Ref.set(
          sources.failNotices,
          new Set([`${CHILD} budget-stopped-0`])
        );

        // One pass finds the child's scope at its line and the root's past its warning line.
        yield* spend(3, GRANDCHILD, 110);
        yield* Effect.sleep(Duration.millis(100));

        // Spend in the root alone: no new spend under the child.
        yield* spend(1, ROOT, 1);

        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(sources.notices), (map) =>
              map.has(`${ROOT} budget-warning-0`)
            )
          ),
          "the root's warning was never written"
        );
        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(sources.raises), (map) => map.has(`${CHILD} 0`))
          ),
          "the child's raise was never asked"
        );
        assert.isTrue(
          (yield* Ref.get(sources.notices)).has(`${CHILD} budget-stopped-0`)
        );
      }).pipe(Effect.provide(GuardWorld))
  );

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
          [[`${CHILD} 0`, 210]]
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

  it.live(
    "acts again when an accepted raise leaves the scope at its line, proposing past what was spent",
    () =>
      Effect.gen(function* () {
        yield* withThreads([[2, 1]]);
        yield* scope(100, "stop");
        yield* (yield* Budgets).load;

        const budgets = yield* Budgets;
        const guard = yield* GuardScript;
        const sources = yield* SourcesScript;

        yield* spend(2, CHILD, 250);

        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(sources.raises), (map) => map.has(`${CHILD} 0`))
          )
        );
        // Already spent past double the line: the raise proposes the spend plus one more line.
        assert.strictEqual(
          (yield* Ref.get(sources.raises)).get(`${CHILD} 0`)?.maxTokens,
          350
        );

        // The user accepts a raise to 200 (an older proposal): still at the line at epoch 1.
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
            Effect.map(Ref.get(sources.raises), (map) => map.has(`${CHILD} 1`))
          )
        );
        assert.strictEqual(
          (yield* Ref.get(sources.raises)).get(`${CHILD} 1`)?.maxTokens,
          450
        );

        const notices = yield* Ref.get(sources.notices);

        assert.include(
          notices.get(`${CHILD} budget-stopped-1`)?.text ?? "",
          "stopped at 250 of 200 tokens"
        );
        assert.isTrue(
          Result.isFailure(yield* Effect.result(budgets.admit(CHILD)))
        );

        // More spend at the same epoch asks nothing more.
        yield* spend(2, CHILD, 10);
        yield* Effect.sleep(Duration.millis(100));

        assert.deepStrictEqual(
          [...(yield* Ref.get(sources.raises)).keys()].toSorted(),
          [`${CHILD} 0`, `${CHILD} 1`]
        );
        assert.strictEqual((yield* Ref.get(guard.pushes)).length, 2);
      }).pipe(Effect.provide(GuardWorld))
  );

  it.live(
    "acts on a scope declared past its line, through the guard or on the next evaluation",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 1],
        ]);
        yield* spend(2, CHILD, 150);
        yield* spend(3, GRANDCHILD, 150);

        const budgets = yield* Budgets;
        const guard = yield* GuardScript;
        const sources = yield* SourcesScript;

        // Through the guard: acted on at once.
        yield* (yield* BudgetGuard).declare(CHILD, tokenBudget(100), "stop");

        assert.isTrue(
          (yield* Ref.get(sources.notices)).has(`${CHILD} budget-stopped-1`)
        );
        assert.deepStrictEqual(
          (yield* Ref.get(guard.stops)).map((stop) => stop.threadId),
          [CHILD]
        );

        // Straight on `Budgets`, its transitions dropped: the next evaluation acts.
        yield* budgets.declare(GRANDCHILD, tokenBudget(100), "drain");

        assert.isFalse(
          (yield* Ref.get(sources.notices)).has(
            `${GRANDCHILD} budget-stopped-1`
          )
        );

        yield* spend(3, GRANDCHILD, 1);

        assert.isTrue(
          yield* eventually(
            Effect.map(Ref.get(sources.notices), (map) =>
              map.has(`${GRANDCHILD} budget-stopped-1`)
            )
          )
        );
      }).pipe(Effect.provide(GuardWorld))
  );
});
