// J-spend (models note, "Judges"; ADR 0036), on the ledger over a scripted feed and a migrated
// in-memory `cairn.sqlite`: a doubled reading leaves the totals unchanged; a bridge model shows its
// tokens and a list-price equivalent labelled `list_on_plan`, priced one response at a time (the
// sum would cross the twin's tier and cost four times as much); an unpriced model adds to
// `unpricedTokens` and leaves `listMicros` alone, on the row too; a recorded cost is kept; usage no
// response explains and a reading the ledger never saw both rebuild the conversation; the boot
// reconcile after deleting `spend_totals` rebuilds identical rows; a repeated call key writes once.
// The arithmetic's outside judge is pi-ai's own `calculateCost` against the twin's catalog entry.

import { Micros, SpendScope } from "@cairn/protocol/Spend";
import { ThreadLineage } from "@cairn/protocol/Subagents";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { ModelSource } from "../brain/ModelSource.ts";
import {
  BRIDGE_KEY,
  FREE_KEY,
  piUsageOf,
  PRICED_KEY,
  spendCatalog,
  SpendFeedScripted,
  twinListMicros,
  SpendScript,
  usageOf,
} from "../brain/SpendTestKit.ts";
import { Database } from "../db/Database.ts";
import { Spend0009 } from "../db/migrations/0009Spend.ts";
import { EventSink } from "../shell/EventSink.ts";
import { ShellStoreLayer } from "../shell/ShellLayer.ts";
import {
  createProject,
  createThread,
  shellMigrations,
  testThreadId,
} from "../shell/ShellTestKit.ts";
import { ThreadRows } from "../shell/ThreadRows.ts";
import { SpendLedger, subtreeOf } from "./SpendLedger.ts";

const catalog = spendCatalog();

const Models = Layer.mock(ModelSource)({
  models: () => catalog,
  settings: () => ({}),
});

const TestLayer = SpendLedger.layerNoDeps.pipe(
  Layer.provideMerge(SpendFeedScripted),
  Layer.provideMerge(ShellStoreLayer),
  Layer.provideMerge(Models),
  Layer.provideMerge(
    Database.layerTest({ ...shellMigrations, "0009_Spend": Spend0009 })
  )
);

const THREAD = testThreadId(1);

/** Lets the ledger take every reading offered so far, then commits pending row figures. */
const settle = Effect.gen(function* () {
  yield* Effect.sleep("20 millis");
  yield* (yield* SpendLedger).flush;
});

const all = SpendLedger.use((ledger) =>
  ledger.rollup(SpendScope.members[3].make({}))
);

const twinMicros = (counts: { input: number; output: number }) =>
  twinListMicros(catalog, usageOf(counts));

const storedRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql`
    SELECT conversation_id, model_key, thread_id, input, output, cache_read, cache_write,
      reasoning, list_micros, basis, unpriced_tokens
    FROM spend_totals ORDER BY conversation_id, model_key
  `;
});

const withThread = Effect.gen(function* () {
  const sink = yield* EventSink;
  const project = createProject(1);

  yield* sink.commitCommand(project.command);
  yield* sink.commitCommand(createThread(project.projectId, 1));

  return project.projectId;
});

const bridgeResponse = (input: number, output: number) => ({
  modelKey: BRIDGE_KEY,
  usage: usageOf({ input, output }),
});

describe("SpendLedger (J-spend)", () => {
  it.live("a doubled reading leaves the totals unchanged", () =>
    Effect.gen(function* () {
      const script = yield* SpendScript;

      const reading = yield* script.commit(1, Option.some(THREAD), {
        responses: [bridgeResponse(1500, 100)],
      });

      yield* settle;
      const once = yield* all;

      yield* script.deliver(reading);
      yield* script.deliver(reading);
      yield* settle;

      assert.deepStrictEqual(yield* all, once);
      assert.strictEqual(once.tokens.input, 1500);
    }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "prices a bridge model at its twin's list price, one response at a time, labelled list_on_plan",
    () =>
      Effect.gen(function* () {
        const script = yield* SpendScript;

        yield* script.commit(1, Option.some(THREAD), {
          responses: [bridgeResponse(1500, 100)],
        });
        yield* script.commit(1, Option.some(THREAD), {
          responses: [bridgeResponse(1500, 100)],
        });
        yield* settle;

        const spend = yield* all;
        const each = twinMicros({ input: 1500, output: 100 });
        const whole = twinMicros({ input: 3000, output: 200 });

        assert.strictEqual(spend.listMicros, 2 * each);
        // The control: pricing the sum would cross the tier.
        assert.isAbove(whole, 2 * each * 3);

        const model = spend.byModel[BRIDGE_KEY];

        assert.isDefined(model);
        assert.strictEqual(model.basis, "list_on_plan");
        assert.strictEqual(model.tokens.input, 3000);
        assert.deepStrictEqual(model.listMicros, Option.some(2 * each));
        assert.strictEqual(spend.unpricedTokens, 0);
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "counts an unpriced model's tokens as unpriced and never as zero dollars, on the row too",
    () =>
      Effect.gen(function* () {
        yield* withThread;
        const script = yield* SpendScript;
        const rows = yield* ThreadRows;
        const before = yield* rows.get(THREAD);

        yield* script.commit(1, Option.some(THREAD), {
          responses: [
            { modelKey: FREE_KEY, usage: usageOf({ input: 900, output: 100 }) },
          ],
        });
        yield* settle;

        const spend = yield* all;
        const model = spend.byModel[FREE_KEY];

        assert.isDefined(model);
        assert.isTrue(Option.isNone(model.listMicros));
        assert.strictEqual(model.basis, "unpriced");
        assert.strictEqual(spend.listMicros, 0);
        assert.strictEqual(spend.unpricedTokens, 1000);
        assert.deepStrictEqual(spend.unpricedModels, [FREE_KEY]);

        const row = yield* rows.get(THREAD);

        assert.isTrue(Option.isSome(row));
        assert.isTrue(Option.isSome(before));

        if (Option.isSome(row) && Option.isSome(before)) {
          assert.deepStrictEqual(
            row.value.shell.spend,
            Option.some({
              totalTokens: 1000,
              listMicros: Micros.make(0),
              unpricedTokens: 1000,
              budget: "none" as const,
            })
          );
          // A spend figure is not activity.
          assert.deepStrictEqual(
            row.value.shell.updatedAt,
            before.value.shell.updatedAt
          );
        }
      }).pipe(Effect.provide(TestLayer))
  );

  it.live("keeps a cost pi-ai recorded at response time", () =>
    Effect.gen(function* () {
      const script = yield* SpendScript;

      yield* script.commit(1, Option.none(), {
        responses: [
          {
            modelKey: PRICED_KEY,
            usage: usageOf({ input: 10_000, output: 500, costTotal: 0.0123 }),
          },
        ],
        tools: [{ name: "web_search", usage: usageOf({ input: 40 }) }],
      });
      yield* settle;

      const spend = yield* all;

      assert.strictEqual(spend.listMicros, 12_300);
      assert.strictEqual(spend.byModel[PRICED_KEY]?.basis, "list_on_plan");
      assert.strictEqual(spend.unpricedTokens, 40);
      assert.deepStrictEqual(spend.unpricedModels, ["tool:web_search"]);
    }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "rebuilds from responses after usage no response explains and after a reading it missed",
    () =>
      Effect.gen(function* () {
        const script = yield* SpendScript;
        const each = twinMicros({ input: 1000, output: 100 });

        yield* script.commit(1, Option.none(), {
          responses: [bridgeResponse(1000, 100)],
        });
        // A compaction attempt on the bridge: tokens with no response to price.
        yield* script.commit(1, Option.none(), {
          unattributed: [
            { modelKey: BRIDGE_KEY, usage: usageOf({ input: 700 }) },
          ],
        });
        // A commit whose reading never reached the ledger.
        yield* script.commit(
          1,
          Option.none(),
          { responses: [bridgeResponse(1000, 100)] },
          { deliver: false }
        );
        yield* script.commit(1, Option.none(), {
          responses: [bridgeResponse(1000, 100)],
        });
        yield* settle;

        const spend = yield* all;

        assert.strictEqual(spend.listMicros, 3 * each);
        assert.strictEqual(spend.unpricedTokens, 700);
        assert.strictEqual(spend.tokens.input, 3700);
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "the boot reconcile rebuilds identical rows after spend_totals is deleted",
    () =>
      Effect.gen(function* () {
        const script = yield* SpendScript;
        const ledger = yield* SpendLedger;
        const sql = yield* SqlClient.SqlClient;

        yield* script.commit(1, Option.some(THREAD), {
          responses: [bridgeResponse(1500, 100)],
        });
        yield* script.commit(1, Option.some(THREAD), {
          unattributed: [
            { modelKey: BRIDGE_KEY, usage: usageOf({ input: 300 }) },
          ],
        });
        yield* script.commit(2, Option.none(), {
          responses: [
            { modelKey: FREE_KEY, usage: usageOf({ input: 50, reasoning: 3 }) },
            {
              modelKey: PRICED_KEY,
              usage: usageOf({ input: 50, costTotal: 0.00025 }),
            },
          ],
        });
        // Delivered: the live rows. Then one the ledger never saw.
        yield* settle;
        yield* script.commit(
          2,
          Option.none(),
          { responses: [bridgeResponse(2500, 10)] },
          { deliver: false }
        );

        const first = yield* ledger.reconcile;

        assert.strictEqual(first.conversations, 2);
        assert.strictEqual(first.rebuilt, 1);

        const live = yield* storedRows;

        yield* sql`DELETE FROM spend_totals`;

        const second = yield* ledger.reconcile;

        assert.strictEqual(second.rebuilt, 2);
        assert.deepStrictEqual(yield* storedRows, live);
        assert.strictEqual((yield* ledger.reconcile).rebuilt, 0);
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "a call outside a conversation under a repeated key writes once",
    () =>
      Effect.gen(function* () {
        const ledger = yield* SpendLedger;

        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "{}" }],
          api: "faux",
          provider: "opencode-go",
          model: "qwen3.8-flash",
          usage: piUsageOf(
            usageOf({ input: 200, output: 20, costTotal: 0.0001 })
          ),
          stopReason: "stop",
          timestamp: 0,
        };

        const call = {
          source: "thread-title",
          key: THREAD,
          threadId: Option.some(THREAD),
        };

        yield* ledger.recordCall(call, message);
        yield* ledger.recordCall(call, message);

        const spend = yield* all;

        assert.strictEqual(spend.tokens.input, 200);
        assert.strictEqual(spend.listMicros, 100);
      }).pipe(Effect.provide(TestLayer))
  );

  it.live(
    "a thread's figure covers its lineage subtree; an unknown thread is not found",
    () =>
      Effect.gen(function* () {
        const projectId = yield* withThread;
        const sink = yield* EventSink;
        const rows = yield* ThreadRows;
        const sql = yield* SqlClient.SqlClient;
        const script = yield* SpendScript;
        const ledger = yield* SpendLedger;
        const child = testThreadId(2);

        yield* sink.commitCommand(createThread(projectId, 2));

        const childRow = yield* rows.get(child);

        assert.isTrue(Option.isSome(childRow));

        if (Option.isSome(childRow)) {
          const lineage = yield* Schema.decodeEffect(ThreadLineage)({
            parentThreadId: THREAD,
            relationshipToParent: "subagent",
            rootThreadId: THREAD,
          });

          yield* sql.withTransaction(
            rows.write({
              ...childRow.value,
              shell: { ...childRow.value.shell, lineage: Option.some(lineage) },
            })
          );
        }

        yield* script.commit(1, Option.some(THREAD), {
          responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: 10 }) }],
        });
        yield* script.commit(2, Option.some(child), {
          responses: [{ modelKey: FREE_KEY, usage: usageOf({ input: 5 }) }],
        });
        yield* settle;

        const parent = yield* ledger.rollup(
          SpendScope.members[0].make({ threadId: THREAD })
        );

        const own = yield* ledger.rollup(
          SpendScope.members[0].make({ threadId: child })
        );

        assert.strictEqual(parent.tokens.input, 15);
        assert.strictEqual(own.tokens.input, 5);

        const parentRow = yield* rows.get(THREAD);

        assert.deepStrictEqual(
          Option.flatMap(parentRow, (row) =>
            Option.map(row.shell.spend, (spend) => spend.totalTokens)
          ),
          Option.some(15)
        );

        const missing = yield* Effect.flip(
          ledger.rollup(
            SpendScope.members[0].make({ threadId: testThreadId(9) })
          )
        );

        assert.strictEqual(missing._tag, "SpendScopeNotFound");
      }).pipe(Effect.provide(TestLayer))
  );

  it("walks a lineage subtree once, even through a cycle", () => {
    const [a, b, c] = [testThreadId(1), testThreadId(2), testThreadId(3)];

    assert.deepStrictEqual(
      subtreeOf(
        a,
        new Map([
          [a, [b]],
          [b, [c, a]],
        ])
      ),
      [a, b, c]
    );
  });
});
