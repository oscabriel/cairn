// Budgets (ADR 0036): where a scope stands against its budget, read from the real spend ledger over
// a scripted feed; what `admit` and the `beforeTool` gate refuse in `stop` and `drain` mode, for the
// scope's own threads, its descendants and a delegating call's target; the row's budget word; the
// raise a scope proposes; and estimates, which say nothing below five samples.

import { Micros } from "@cairn/protocol/Spend";
import type { Budget } from "@cairn/protocol/Spend";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Option, Ref } from "effect";

import {
  FREE_KEY,
  PRICED_KEY,
  SpendScript,
  usageOf,
} from "../brain/SpendTestKit.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import type { BudgetMode, ScopeLimit } from "./BudgetBook.ts";
import {
  Budgets,
  dollarsOf,
  estimateOf,
  raisedBudget,
  standingOf,
  tokensOf,
} from "./Budgets.ts";
import {
  BudgetsWorld,
  settle,
  SourcesScript,
  tokenBudget,
  withThreads,
} from "./BudgetTestKit.ts";

const ROOT = testThreadId(1);

const CHILD = testThreadId(2);

const GRANDCHILD = testThreadId(3);

const OTHER = testThreadId(4);

const spent = (tokens: number, listMicros = 0, unpricedTokens = 0) => ({
  tokens,
  listMicros,
  unpricedTokens,
});

/** Registers `budget` on `threadId`'s subtree in the in-memory documents and loads the book. */
const scope = (threadId: typeof ROOT, budget: Budget, mode: BudgetMode) =>
  Effect.gen(function* () {
    const script = yield* SourcesScript;
    const limit: ScopeLimit = { threadId, budget, mode, epoch: 0 };

    yield* Ref.update(script.scopes, (map) =>
      new Map(map).set(threadId, limit)
    );

    return yield* (yield* Budgets).load;
  });

/** `tokens` unpriced tokens spent by `thread` in its own conversation. */
const spend = (conversation: number, thread: typeof ROOT, tokens: number) =>
  Effect.gen(function* () {
    const script = yield* SpendScript;

    yield* script.commit(conversation, Option.some(thread), {
      responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: tokens }) }],
    });
    yield* settle;
  });

describe("where a scope stands", () => {
  it("is none without an enforced limit, and moves from within to warned to exhausted", () => {
    assert.strictEqual(standingOf(tokenBudget(100), spent(0)).state, "within");
    assert.strictEqual(standingOf(tokenBudget(100), spent(79)).state, "within");
    assert.strictEqual(standingOf(tokenBudget(100), spent(80)).state, "warned");

    const at = standingOf(tokenBudget(100), spent(100));

    assert.strictEqual(at.state, "exhausted");
    assert.deepStrictEqual(at.reached, Option.some("tokens"));

    const none = standingOf(
      { ...tokenBudget(100), maxTokens: null, maxTurns: 3 },
      spent(1000)
    );

    assert.strictEqual(none.state, "none");
  });

  it("binds a dollar limit to priced tokens only, so unpriced tokens never reach it", () => {
    const budget: Budget = {
      ...tokenBudget(1_000_000),
      maxTokens: null,
      maxListMicros: Micros.make(10_000),
    };

    assert.strictEqual(
      standingOf(budget, spent(900_000, 9000, 890_000)).state,
      "warned"
    );
    assert.strictEqual(
      standingOf(budget, spent(10, 10_000)).state,
      "exhausted"
    );
    assert.deepStrictEqual(
      standingOf(budget, spent(10, 10_000)).reached,
      Option.some("dollars")
    );
  });

  it("raises the reached limit only, doubled when that clears the spend", () => {
    const budget: Budget = {
      ...tokenBudget(1000),
      maxListMicros: Micros.make(50_000),
    };

    const raised = raisedBudget(budget, {
      reached: Option.some("tokens"),
      spent: spent(1000, 20_000),
    });

    assert.strictEqual(raised.maxTokens, 2000);
    assert.strictEqual(raised.maxListMicros, 50_000);
  });

  it("raises past what was already spent, by one more of the old line", () => {
    const raised = raisedBudget(tokenBudget(1000), {
      reached: Option.some("tokens"),
      spent: spent(2500),
    });

    assert.strictEqual(raised.maxTokens, 3500);
    assert.strictEqual(standingOf(raised, spent(2500)).state, "within");
  });

  it("formats figures as people read them", () => {
    assert.strictEqual(dollarsOf(420_000), "$0.42");
    assert.strictEqual(dollarsOf(900), "under $0.01");
    assert.strictEqual(dollarsOf(0), "$0.00");
    assert.strictEqual(tokensOf(950), "950");
    assert.strictEqual(tokensOf(12_300), "12.3k");
    assert.strictEqual(tokensOf(2_000_000), "2M");
  });
});

describe("estimates", () => {
  it("says nothing below five samples", () => {
    const four = [1, 2, 3, 4].map((n) => ({ listMicros: n, tokens: n * 10 }));

    assert.isTrue(Option.isNone(estimateOf(four)));
  });

  it("gives the median and the 90th percentile", () => {
    const ten = [5, 1, 9, 3, 7, 2, 8, 4, 10, 6].map((n) => ({
      listMicros: n * 100,
      tokens: n * 1000,
    }));

    assert.deepStrictEqual(
      estimateOf(ten),
      Option.some({
        samples: 10,
        tokensMedian: 5000,
        tokensHigh: 9000,
        listMicrosMedian: 500,
        listMicrosHigh: 900,
      })
    );
  });
});

describe("budgets over the ledger", () => {
  it.live(
    "a stop scope at its line refuses every tool in its subtree but submit_result, and every delegation",
    () =>
      Effect.gen(function* () {
        yield* withThreads([
          [2, 1],
          [3, 2],
          [4, 1],
        ]);

        const budgets = yield* Budgets;

        yield* scope(CHILD, tokenBudget(100), "stop");
        yield* spend(2, CHILD, 60);

        const below = yield* budgets.evaluate([CHILD]);

        assert.deepStrictEqual(below, []);
        assert.isTrue(
          Option.isNone(yield* budgets.gate(GRANDCHILD, "bash", Option.none()))
        );

        yield* spend(3, GRANDCHILD, 50);

        const moved = yield* budgets.evaluate([GRANDCHILD]);

        assert.deepStrictEqual(
          moved.map((each) => [
            each.limit.threadId,
            each.before.state,
            each.after.state,
          ]),
          [[CHILD, "within", "exhausted"]]
        );

        for (const thread of [CHILD, GRANDCHILD]) {
          const blocked = yield* budgets.gate(thread, "bash", Option.none());

          assert.isTrue(Option.isSome(blocked));
          assert.include(
            Option.getOrElse(blocked, () => ""),
            "110 of 100 tokens"
          );
          assert.isTrue(
            Option.isNone(
              yield* budgets.gate(thread, "submit_result", Option.none())
            )
          );
        }

        // The root and its other child stand outside the scope.
        assert.isTrue(
          Option.isNone(yield* budgets.gate(ROOT, "bash", Option.none()))
        );
        assert.isTrue(
          Option.isNone(yield* budgets.gate(OTHER, "bash", Option.none()))
        );

        // Sending the stopped child more work from the root is refused, at the gate and at admit.
        assert.isTrue(
          Option.isSome(
            yield* budgets.gate(ROOT, "subagent_send", Option.some(CHILD))
          )
        );
        assert.isTrue(
          Option.isNone(
            yield* budgets.gate(ROOT, "subagent_send", Option.some(OTHER))
          )
        );

        const refused = yield* Effect.flip(budgets.admit(GRANDCHILD));

        assert.strictEqual(refused._tag, "BudgetExhausted");
        assert.strictEqual(refused.scope, CHILD);
        assert.strictEqual(refused.spent, 110);
        assert.strictEqual(refused.max, 100);

        yield* budgets.admit(OTHER);
      }).pipe(Effect.provide(BudgetsWorld))
  );

  it.live(
    "a drain scope at its line refuses only delegation, and its row says exhausted",
    () =>
      Effect.gen(function* () {
        yield* withThreads([[2, 1]]);

        const budgets = yield* Budgets;
        const rows = yield* ThreadRows;

        yield* scope(ROOT, tokenBudget(100), "drain");
        yield* spend(1, ROOT, 40);
        yield* spend(2, CHILD, 70);
        yield* budgets.evaluate([CHILD]);
        yield* settle;

        assert.isTrue(
          Option.isNone(yield* budgets.gate(CHILD, "bash", Option.none()))
        );
        assert.isTrue(
          Option.isSome(
            yield* budgets.gate(ROOT, "subagent_spawn", Option.none())
          )
        );
        assert.isTrue(
          Option.isSome(
            yield* budgets.gate(CHILD, "subagent_spawn", Option.none())
          )
        );

        const root = yield* rows.get(ROOT);
        const child = yield* rows.get(CHILD);

        assert.deepStrictEqual(
          Option.map(
            Option.flatMap(root, (row) => row.shell.spend),
            (figure) => [figure.totalTokens, figure.budget]
          ),
          Option.some([110, "exhausted"])
        );
        // A thread heading no scope keeps the word none.
        assert.deepStrictEqual(
          Option.map(
            Option.flatMap(child, (row) => row.shell.spend),
            (figure) => figure.budget
          ),
          Option.some("none")
        );
      }).pipe(Effect.provide(BudgetsWorld))
  );

  it.live("a raise re-read from the documents lets work start again", () =>
    Effect.gen(function* () {
      yield* withThreads([[2, 1]]);

      const budgets = yield* Budgets;
      const script = yield* SourcesScript;

      yield* scope(CHILD, tokenBudget(50), "stop");
      yield* spend(2, CHILD, 60);
      yield* budgets.evaluate([CHILD]);

      assert.isTrue(
        Option.isSome(yield* budgets.gate(CHILD, "read", Option.none()))
      );

      yield* Ref.update(script.scopes, (map) =>
        new Map(map).set(CHILD, {
          threadId: CHILD,
          budget: tokenBudget(200),
          mode: "stop",
          epoch: 1,
        })
      );

      const moved = yield* budgets.refresh(CHILD);

      assert.deepStrictEqual(
        moved.map((each) => each.after.state),
        ["within"]
      );
      assert.isTrue(
        Option.isNone(yield* budgets.gate(CHILD, "read", Option.none()))
      );
      yield* budgets.admit(CHILD);
    }).pipe(Effect.provide(BudgetsWorld))
  );

  it.live("a dollar budget counts recorded list prices", () =>
    Effect.gen(function* () {
      yield* withThreads([]);

      const budgets = yield* Budgets;
      const feed = yield* SpendScript;

      yield* scope(
        ROOT,
        { ...tokenBudget(10_000_000), maxListMicros: Micros.make(20_000) },
        "stop"
      );

      yield* feed.commit(1, Option.some(ROOT), {
        responses: [
          {
            modelKey: PRICED_KEY,
            usage: usageOf({ input: 100, costTotal: 0.017 }),
          },
        ],
      });
      yield* settle;

      const first = yield* budgets.evaluate([ROOT]);

      assert.deepStrictEqual(
        first.map((each) => each.after.state),
        ["warned"]
      );

      yield* feed.commit(1, Option.some(ROOT), {
        responses: [
          {
            modelKey: PRICED_KEY,
            usage: usageOf({ input: 100, costTotal: 0.017 }),
          },
        ],
      });
      yield* settle;

      const second = yield* budgets.evaluate([ROOT]);

      assert.deepStrictEqual(
        second.map((each) => [each.after.state, each.after.spent.listMicros]),
        [["exhausted", 34_000]]
      );
      assert.deepStrictEqual(second[0]?.after.reached, Option.some("dollars"));
    }).pipe(Effect.provide(BudgetsWorld))
  );
});
