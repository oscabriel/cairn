// Durable events and the reactor host over a real pi-durable store (ADR 0033): an event exists
// exactly when the commit that emitted it does; a reactor handles each of its events once, oldest
// first, skipping other kinds; a throwing handler rolls back its writes with its cursor and is
// retried; an event a handler keeps failing on, or cannot read, is dead-lettered once, pushed, and
// the reactor goes on (the 7B incident replayed on the production budget reactor); the log rotates monthly and a reactor follows the marker into the next log, and `cairn.events` decodes with the protocol's `EventsDocument`; a task a
// handler creates runs once; the status counts what is pending; an entry is the protocol's
// envelope; a new reactor starts where its `from` says; a Session reopen wakes the reactors; `stop`
// waits for the step in flight; and a bad reactor name kills the layer. The kill -9 half of the
// judge is `judges/events-kill.sh`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ConversationId } from "@cairn/protocol/Ids";
import { DEFAULT_BUDGET, Budget } from "@cairn/protocol/Spend";
import { NOTICE_ENTRY_KIND } from "@cairn/protocol/Thread";
import { EventEnvelope, EventsDocument } from "@cairn/protocol/Workflows";
import type { JsonValue } from "@earendil-works/chord/json";
import type { SessionDocToken, Storage, Tx } from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Schema,
} from "effect";
import type { Scope } from "effect";

import {
  eventuallyTrue as eventually,
  testLimit,
} from "../EventuallyTestKit.ts";
import {
  budgetPushTask,
  NO_BUDGET_PUSH,
  workflowBudgetReactor,
} from "../workflows/WorkflowBudget.ts";
import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore } from "./BrainStore.ts";
import { durable } from "./Durable.ts";
import {
  DEAD_LETTER_AFTER,
  EventReactors,
  NO_DEAD_LETTER_PUSH,
} from "./EventReactors.ts";
import type { DeadLetterPush } from "./EventReactors.ts";
import type {
  DeadLettersState,
  EventDraft,
  EventsState,
  Reactor,
} from "./Events.ts";
import {
  DeadLettersDoc,
  deadLetterKey,
  emit,
  EventsDoc,
  isEventObject,
  monthOf,
  reactor,
} from "./Events.ts";
import { Extensions } from "./Extensions.ts";
import { ModelSource } from "./ModelSource.ts";
import { piConversationId, piEntryId } from "./PiIds.ts";

/** What the test reactors write, through `tx` only. */
interface Seen {
  [key: string]: JsonValue;
  /** Handled event ids per reactor, in handling order. */
  handled: { [reactor: string]: Array<number> };
  /** Handler attempts per reactor and event, rolled back with a failed step. */
  attempts: { [key: string]: number };
  /** Tasks a handler created, by event id, and the times each ran to its end. */
  created: { [eventId: string]: number };
  ran: { [eventId: string]: number };
  /** The conversation the created tasks live in; 0 until the first. */
  home: number;
}

const SeenDoc = defineDoc<Seen>({
  kind: "cairn.test-events-seen",
  version: 1,
  scope: "session",
  initial: () => ({ handled: {}, attempts: {}, created: {}, ran: {}, home: 0 }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

/** A task a handler creates: it records that it ran, once, in its terminal commit. */
const RecordRun = defineTask<
  { readonly eventId: number },
  { readonly phase: "run" },
  number
>({
  name: "cairn.test-record-run",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      await runtime.commit(async (tx) => {
        const seen = await tx.doc(SeenDoc);
        const key = String(task.input.eventId);

        seen.ran[key] = (seen.ran[key] ?? 0) + 1;

        return {
          status: "terminal",
          outcome: { status: "completed", result: task.input.eventId },
        };
      }, context);
    },
  },
  abort: async (_task, runtime, context) => {
    await runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context
    );
  },
});

const TestTasks = defineExtension({
  name: "cairn.test-events",
  // The budget reactor's soft line creates its push task, which the workflows extension carries.
  tasks: [RecordRun, budgetPushTask(NO_BUDGET_PUSH)],
});

const epoch = (iso: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(iso));

const OCTOBER = epoch("2999-10-31T23:00:00Z");

const NOVEMBER = epoch("2999-11-01T00:30:00Z");

const record = async (tx: Tx, name: string, id: number) => {
  const seen = await tx.doc(SeenDoc);

  const handled = seen.handled[name] ?? [];

  handled.push(id);
  seen.handled[name] = handled;
};

/** A handler that records each event it is given under `name`. */
const recorder =
  (name: string) => async (tx: Tx, event: { readonly id: number }) => {
    await record(tx, name, event.id);
  };

/** A reactor that does nothing, under `name`. */
const named = (name: string) =>
  reactor(
    name,
    { events: ["workflow.node.settled"], from: "now" },
    async () => {
      await Promise.resolve();
    }
  );

/** Whether the reopen reactor has failed its Session yet. */
const armed = { done: false };

/** Events the flaky reactor lets through; it throws on every other one after writing. */
const passing = new Set<number>();

/** Counts its attempt and records the event, then throws unless let through: both writes roll back. */
const flaky = (name: string) =>
  reactor(
    name,
    { events: ["workflow.node.settled"], from: "start" },
    async (tx, event) => {
      const seen = await tx.doc(SeenDoc);
      const key = `${name}:${event.id}`;
      const attempts = (seen.attempts[key] ?? 0) + 1;

      seen.attempts[key] = attempts;
      await record(tx, name, event.id);

      if (!passing.has(event.id)) {
        throw new Error(`injected fault on ${event.id}`);
      }
    }
  );

/** Set it and the store's next commit rejects, failing the Session as a platform reset would. */
const failNext = { value: false };

const failing = (storage: Storage): Storage => {
  const commitWrites = storage.commit.bind(storage);

  storage.commit = async (batches, receive, context) => {
    if (failNext.value) {
      failNext.value = false;

      throw new Error("storage reset (test)");
    }

    return await commitWrites(batches, receive, context);
  };

  return storage;
};

const failingStore = Layer.effect(
  BrainStore,
  Effect.map(BrainStore, (real) =>
    BrainStore.of({ ...real, open: Effect.map(real.open, failing) })
  )
).pipe(Layer.provide(BrainStore.layer));

const brainLayer = (
  dataDir: string,
  reactors: ReadonlyArray<Reactor>,
  push: DeadLetterPush = NO_DEAD_LETTER_PUSH
) =>
  EventReactors.fromSources(
    reactors.map((each) => Effect.succeed(each)),
    Effect.succeed(push)
  ).pipe(
    Layer.provideMerge(
      Brain.layerNoDeps.pipe(
        Layer.provide(failingStore),
        Layer.provide(Arms.layer)
      )
    ),
    Layer.provide(
      Extensions.fromSources([
        Effect.succeed({ order: 900, extension: TestTasks }),
      ])
    ),
    Layer.provide(
      ModelSource.layerFaux({ tokensPerSecond: 2000, settings: {} })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

const withBrain = <A, E>(
  reactors: ReadonlyArray<Reactor>,
  use: (
    context: Context.Context<EventReactors | Brain>
  ) => Effect.Effect<A, E, Scope.Scope>,
  push: DeadLetterPush = NO_DEAD_LETTER_PUSH
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-events-test-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.flatMap(Layer.build(brainLayer(dataDir, reactors, push)), use)
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

const commit = <A>(brain: Brain["Service"], change: (tx: Tx) => Promise<A>) =>
  Effect.flatMap(brain.session, (session) =>
    durable(
      "test.commit",
      async (context) => await session.harness.commit(change, context)
    )
  );

const emitOne = (brain: Brain["Service"], draft: EventDraft) =>
  commit(brain, async (tx) => {
    const event = await emit(tx, draft);

    return event.id;
  });

const settled = (at: number, n: number): EventDraft => ({
  name: "workflow.node.settled",
  data: { n },
  at,
  context: Option.none(),
});

const snapshot = <T extends Seen | EventsState>(
  brain: Brain["Service"],
  token: SessionDocToken<T>,
  initial: T
) =>
  Effect.flatMap(brain.session, (session) =>
    durable(
      "test.snapshot",
      async (context) =>
        (await session.harness.snapshot(token, context)) ?? initial
    )
  );

const readSeen = (brain: Brain["Service"]) =>
  snapshot(brain, SeenDoc, {
    handled: {},
    attempts: {},
    created: {},
    ran: {},
    home: 0,
  });

const readEvents = (brain: Brain["Service"]) =>
  snapshot(brain, EventsDoc, {
    logConversationId: null,
    logMonth: null,
    cursors: {},
  });

const readLetters = (brain: Brain["Service"]) =>
  Effect.flatMap(brain.session, (session) =>
    durable(
      "test.snapshot",
      async (context): Promise<DeadLettersState> =>
        (await session.harness.snapshot(DeadLettersDoc, context)) ?? {
          items: {},
        }
    )
  );

/** A push sink that keeps what it is handed. */
const pushesInto =
  (kept: Array<string>): DeadLetterPush =>
  (letter) =>
    Effect.sync(() => {
      kept.push(deadLetterKey(letter.reactor, letter.eventId));
    });

const encodeBudget = Schema.encodeSync(Budget);

/** True once every reactor has nothing pending. */
const caughtUp = (reactors: EventReactors["Service"]) =>
  Effect.map(reactors.status, (status) =>
    status.reactors.every((each) => each.lag === 0)
  );

describe("durable events", () => {
  it("monthOf is the UTC month", () => {
    assert.strictEqual(monthOf(OCTOBER), "2999-10");
    assert.strictEqual(monthOf(NOVEMBER), "2999-11");
  });

  it.live(
    "a reactor handles each of its events once, oldest first, and skips other kinds",
    () =>
      withBrain(
        [
          reactor(
            "settled",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              await record(tx, "settled", event.id);
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            const first = yield* emitOne(brain, settled(OCTOBER, 1));

            yield* emitOne(brain, {
              name: "workflow.node.refused",
              data: { n: 2 },
              at: OCTOBER,
              context: Option.none(),
            });

            const third = yield* emitOne(brain, settled(OCTOBER, 3));

            const before = yield* reactors.status;

            assert.strictEqual(before.reactors[0]?.lag, 2, "lag before start");

            yield* reactors.start;
            assert.isTrue(yield* eventually(caughtUp(reactors)));

            const fourth = yield* emitOne(brain, settled(OCTOBER, 4));

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  readSeen(brain),
                  (seen) => (seen.handled.settled ?? []).length === 3
                )
              )
            );

            const seen = yield* readSeen(brain);

            assert.deepStrictEqual(seen.handled.settled, [
              first,
              third,
              fourth,
            ]);

            const after = yield* reactors.status;

            assert.strictEqual(after.reactors[0]?.lag, 0);
            assert.isTrue(
              Option.isSome(after.reactors[0]?.lastHandledAt ?? Option.none())
            );
          })
      ),
    testLimit(20_000)
  );

  it.live("an event exists only when the commit that emitted it does", () =>
    withBrain([], (context) =>
      Effect.gen(function* () {
        const brain = Context.get(context, Brain);

        const failed = yield* Effect.flip(
          commit(brain, async (tx) => {
            await emit(tx, settled(OCTOBER, 1));

            throw new Error("the change failed");
          })
        );

        assert.include(failed.message, "the change failed");

        const state = yield* readEvents(brain);

        assert.strictEqual(state.logConversationId, null);
      })
    )
  );

  it.live(
    "a throwing handler rolls back its writes with its cursor and is retried until it passes",
    () =>
      withBrain([flaky("flaky")], (context) =>
        Effect.gen(function* () {
          const brain = Context.get(context, Brain);
          const reactors = Context.get(context, EventReactors);

          yield* reactors.start;

          const ids: Array<number> = [];

          for (let n = 1; n <= 3; n += 1) {
            ids.push(yield* emitOne(brain, settled(OCTOBER, n)));
          }

          // Every attempt throws after writing, and the rollback takes the writes and the cursor
          // with it: nothing recorded, no attempt counted, every event still pending.
          yield* Effect.sleep(Duration.millis(400));

          const stuck = yield* readSeen(brain);
          const status = yield* reactors.status;

          assert.deepStrictEqual(stuck.handled.flaky ?? [], []);
          assert.deepStrictEqual(stuck.attempts, {});
          assert.strictEqual(status.reactors[0]?.lag, 3);
          assert.isAbove(status.reactors[0]?.failuresInARow ?? 0, 0);
          assert.include(
            Option.getOrThrow(status.reactors[0]?.lastFailure ?? Option.none())
              .message,
            `injected fault on ${ids[0]}`
          );

          // Let every event pass: the next retry handles each once, in order.
          for (const id of ids) {
            passing.add(id);
          }

          assert.isTrue(yield* eventually(caughtUp(reactors)));

          const seen = yield* readSeen(brain);
          const after = yield* reactors.status;

          assert.deepStrictEqual(seen.handled.flaky, ids);
          assert.strictEqual(after.reactors[0]?.failuresInARow, 0);
        })
      ),
    testLimit(20_000)
  );

  it.live(
    "an event its handler never passes is dead-lettered after the limit, pushed, and the next is handled",
    () => {
      const pushed: Array<string> = [];

      return withBrain(
        [
          reactor(
            "stuck",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              await record(tx, "stuck", event.id);

              if (isEventObject(event.data) && event.data.n === 1) {
                throw new Error(`no handling ${String(event.id)}`);
              }
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            yield* reactors.start;

            const bad = yield* emitOne(brain, settled(OCTOBER, 1));
            const next = yield* emitOne(brain, settled(OCTOBER, 2));

            assert.isTrue(
              yield* eventually(caughtUp(reactors)),
              "the reactor got past the event it never handles"
            );

            const seen = yield* readSeen(brain);
            const letters = yield* readLetters(brain);
            const status = yield* reactors.status;
            const letter = letters.items[deadLetterKey("stuck", bad)];

            assert.deepStrictEqual(seen.handled.stuck, [next]);
            assert.strictEqual(letter?.failures, DEAD_LETTER_AFTER);
            assert.strictEqual(letter?.kind, "event.workflow.node.settled");
            assert.include(letter?.error ?? "", `no handling ${String(bad)}`);
            assert.deepStrictEqual(pushed, [deadLetterKey("stuck", bad)]);
            assert.strictEqual(status.reactors[0]?.failuresInARow, 0);
            assert.include(
              Option.getOrThrow(
                status.reactors[0]?.lastFailure ?? Option.none()
              ).message,
              `Dead-lettered event ${String(bad)}`
            );
          }),
        pushesInto(pushed)
      );
    },
    testLimit(20_000)
  );

  it.live(
    "7B replayed: the budget reactor passes 50 events it cannot read at once, and handles the next line",
    () => {
      const pushed: Array<string> = [];

      return withBrain(
        [workflowBudgetReactor],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            yield* reactors.start;

            // The events judge's producer before 7B: `workflow.budget.soft` with its own data,
            // not the meter's. Each held the budget reactor for ever, at lag 50.
            const bad: Array<number> = [];

            for (let n = 1; n <= 50; n += 1) {
              bad.push(
                yield* emitOne(brain, {
                  name: "workflow.budget.soft",
                  data: { n },
                  at: OCTOBER,
                  context: Option.none(),
                })
              );
            }

            // Then a real soft line, in a thread of its own.
            const thread = yield* commit(brain, async (tx) => {
              const created = await tx.createConversation({
                ownership: { kind: "ownerless" },
              });

              return created.id;
            });

            yield* emitOne(brain, {
              name: "workflow.budget.soft",
              data: {
                workflowId: "wf-line",
                conversationId: thread,
                epoch: 0,
                limit: "tokens",
                spent: {
                  tokens: 900,
                  listMicros: 0,
                  unpricedTokens: 0,
                  turns: 1,
                },
                budget: encodeBudget({ ...DEFAULT_BUDGET, maxTokens: 1000 }),
              },
              at: OCTOBER,
              context: Option.none(),
            });

            assert.isTrue(
              yield* eventually(caughtUp(reactors)),
              "the budget reactor got past the 50 events it cannot read"
            );

            const letters = yield* readLetters(brain);
            const status = yield* reactors.status;

            const notices = yield* commit(brain, async (tx) => {
              const page = await tx.scanEntries(
                { conversationId: thread, order: "ascending" },
                10
              );

              return page.items.filter(
                (entry) => entry.kind === NOTICE_ENTRY_KIND
              ).length;
            });

            assert.deepStrictEqual(
              Object.values(letters.items).map((letter) => [
                letter.eventId,
                letter.failures,
              ]),
              bad.map((id) => [id, 1]),
              "each passed on its first failure, never retried"
            );
            assert.strictEqual(notices, 1, "the next line was handled");
            assert.strictEqual(status.reactors[0]?.lag, 0);
            assert.strictEqual(status.reactors[0]?.failuresInARow, 0);
            // Every letter is handed to the outbox, which gathers the run into one push
            // (WorkflowPushes.test.ts).
            assert.deepStrictEqual(
              pushed,
              bad.map((id) => deadLetterKey(workflowBudgetReactor.name, id))
            );
          }),
        pushesInto(pushed)
      );
    },
    testLimit(20_000)
  );

  it.live(
    "a reactor's last dead letter shows in the status after a restart",
    () =>
      Effect.gen(function* () {
        const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-events-test-"));

        const life = <A, E>(
          use: (
            context: Context.Context<EventReactors | Brain>
          ) => Effect.Effect<A, E, Scope.Scope>
        ) =>
          Effect.scoped(
            Effect.flatMap(
              Layer.build(brainLayer(dataDir, [workflowBudgetReactor])),
              use
            )
          ).pipe(Effect.orDie);

        const lines = yield* Effect.gen(function* () {
          const bad = yield* life((context) =>
            Effect.gen(function* () {
              const brain = Context.get(context, Brain);
              const reactors = Context.get(context, EventReactors);

              yield* reactors.start;

              const id = yield* emitOne(brain, {
                name: "workflow.budget.soft",
                data: { n: 1 },
                at: OCTOBER,
                context: Option.none(),
              });

              assert.isTrue(yield* eventually(caughtUp(reactors)));

              return id;
            })
          );

          // The next life has seen no failure of its own.
          const status = yield* life(
            (context) => Context.get(context, EventReactors).status
          );

          return {
            bad,
            line: Option.map(
              status.reactors[0]?.lastFailure ?? Option.none(),
              (failure) => failure.message
            ),
          };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(dataDir, { recursive: true, force: true });
            })
          )
        );

        assert.include(
          Option.getOrElse(lines.line, () => ""),
          `Dead-lettered event ${String(lines.bad)}`
        );
      }),
    testLimit(20_000)
  );

  it.live(
    "the log rotates at a new month and a reactor follows the marker into the next log",
    () =>
      withBrain(
        [
          reactor(
            "settled",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              await record(tx, "settled", event.id);
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            // Registered and stopped before any event: its cursor waits at the start of the first
            // log, opened in the current month. The test months lie far ahead, so the October event
            // rotates once and November once more, whenever the test runs.
            yield* reactors.start;
            yield* reactors.stop;

            const october = yield* emitOne(brain, settled(OCTOBER, 1));
            const first = yield* readEvents(brain);
            const november = yield* emitOne(brain, settled(NOVEMBER, 2));
            // A late clock never rotates back.
            const late = yield* emitOne(brain, settled(OCTOBER, 3));
            const second = yield* readEvents(brain);

            assert.strictEqual(first.logMonth, "2999-10");
            assert.strictEqual(second.logMonth, "2999-11");
            assert.notStrictEqual(
              second.logConversationId,
              first.logConversationId
            );

            yield* reactors.start;
            assert.isTrue(yield* eventually(caughtUp(reactors)));

            const seen = yield* readSeen(brain);
            const state = yield* readEvents(brain);

            assert.deepStrictEqual(seen.handled.settled, [
              october,
              november,
              late,
            ]);
            assert.deepStrictEqual(state.cursors.settled, {
              logConversationId: second.logConversationId ?? 0,
              entryId: late,
            });
            // What the host committed is the protocol's `cairn.events`.
            assert.isTrue(
              Option.isSome(Schema.decodeOption(EventsDocument)(state))
            );
          })
      ),
    testLimit(20_000)
  );

  it.live(
    "a task a handler creates is created once and runs once",
    () =>
      withBrain(
        [
          reactor(
            "spawn",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              const seen = await tx.doc(SeenDoc);
              let { home } = seen;

              if (home === 0) {
                const created = await tx.createConversation({
                  ownership: { kind: "ownerless" },
                });

                home = created.id;
                seen.home = home;
              }

              const key = String(event.id);

              seen.created[key] = (seen.created[key] ?? 0) + 1;
              await tx.createTask(
                RecordRun,
                { eventId: event.id },
                {
                  ownership: { kind: "conversation" },
                  conversationId: piConversationId(ConversationId.make(home)),
                  background: true,
                }
              );
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            yield* reactors.start;
            yield* brain.resume;

            const ids: Array<number> = [];

            for (let n = 1; n <= 4; n += 1) {
              ids.push(yield* emitOne(brain, settled(OCTOBER, n)));
            }

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  readSeen(brain),
                  (seen) => Object.keys(seen.ran).length === ids.length
                )
              )
            );

            const seen = yield* readSeen(brain);

            for (const id of ids) {
              assert.strictEqual(seen.created[String(id)], 1, `created ${id}`);
              assert.strictEqual(seen.ran[String(id)], 1, `ran ${id}`);
            }
          })
      ),
    testLimit(20_000)
  );

  it.live(
    "an emitted entry is the protocol's EventEnvelope, context and all",
    () =>
      withBrain([], (context) =>
        Effect.gen(function* () {
          const brain = Context.get(context, Brain);

          const ids = yield* commit(brain, async (tx) => {
            const bare = await emit(tx, settled(OCTOBER, 1));

            const placed = await emit(tx, {
              name: "workflow.node.refused",
              data: { n: 2 },
              at: OCTOBER,
              context: Option.some({ runId: "run-1" }),
            });

            return [bare.id, placed.id];
          });

          const state = yield* readEvents(brain);

          const entries = yield* commit(brain, async (tx) => {
            const page = await tx.scanEntries(
              {
                conversationId: piConversationId(
                  ConversationId.make(state.logConversationId ?? 0)
                ),
                order: "ascending",
              },
              10
            );

            return page.items.map((entry) => ({
              id: entry.id,
              data: entry.data,
            }));
          });

          const decode = Schema.decodeUnknownEffect(EventEnvelope);

          assert.deepStrictEqual(
            entries.map((entry) => entry.id),
            ids.map((id) => piEntryId(id))
          );
          assert.deepStrictEqual(yield* decode(entries[0]?.data), {
            v: 1,
            at: OCTOBER,
            data: { n: 1 },
            context: null,
          });
          assert.deepStrictEqual(yield* decode(entries[1]?.data), {
            v: 1,
            at: OCTOBER,
            data: { n: 2 },
            context: { runId: "run-1" },
          });
        })
      ),
    testLimit(20_000)
  );

  it.live(
    "a reactor that starts now skips what came before it; one that starts at the start does not",
    () =>
      Effect.gen(function* () {
        // A first life with no reactors writes two events; a later deploy adds both reactors.
        const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-events-test-"));

        const life = <A, E>(
          reactors: ReadonlyArray<Reactor>,
          use: (
            context: Context.Context<EventReactors | Brain>
          ) => Effect.Effect<A, E, Scope.Scope>
        ) =>
          Effect.scoped(
            Effect.flatMap(Layer.build(brainLayer(dataDir, reactors)), use)
          ).pipe(Effect.orDie);

        const before = yield* life([], (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);

            return [
              yield* emitOne(brain, settled(OCTOBER, 1)),
              yield* emitOne(brain, settled(OCTOBER, 2)),
            ];
          })
        );

        const seen = yield* life(
          [
            reactor(
              "late-now",
              { events: ["workflow.node.settled"], from: "now" },
              recorder("late-now")
            ),
            reactor(
              "late-start",
              { events: ["workflow.node.settled"], from: "start" },
              recorder("late-start")
            ),
          ],
          (context) =>
            Effect.gen(function* () {
              const brain = Context.get(context, Brain);
              const reactors = Context.get(context, EventReactors);

              yield* reactors.start;

              const after = yield* emitOne(brain, settled(OCTOBER, 3));

              assert.isTrue(
                yield* eventually(
                  Effect.map(
                    readSeen(brain),
                    (state) =>
                      (state.handled["late-now"] ?? []).length === 1 &&
                      (state.handled["late-start"] ?? []).length === 3
                  )
                )
              );

              const state = yield* readSeen(brain);

              return { state, after };
            })
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              rmSync(dataDir, { recursive: true, force: true });
            })
          )
        );

        assert.deepStrictEqual(seen.state.handled["late-now"], [seen.after]);
        assert.deepStrictEqual(seen.state.handled["late-start"], [
          ...before,
          seen.after,
        ]);
      }),
    testLimit(20_000)
  );

  it.live(
    "a Session that fails and reopens wakes the reactor, and an event after the reopen is handled",
    () =>
      withBrain(
        [
          reactor(
            "reopen",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              // The first step's commit fails the store under it: the Session reopens.
              if (!armed.done) {
                armed.done = true;
                failNext.value = true;
              }

              await record(tx, "reopen", event.id);
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);
            const first = (yield* brain.session).generation;

            yield* reactors.start;

            const cut = yield* emitOne(brain, settled(OCTOBER, 1));

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  Effect.option(brain.session),
                  (session) =>
                    Option.isSome(session) && session.value.generation > first
                )
              ),
              "the Session never reopened"
            );

            const after = yield* emitOne(brain, settled(OCTOBER, 2));

            assert.isTrue(
              yield* eventually(
                Effect.map(
                  readSeen(brain),
                  (seen) => (seen.handled.reopen ?? []).length === 2
                )
              )
            );

            const seen = yield* readSeen(brain);

            assert.deepStrictEqual(seen.handled.reopen, [cut, after]);
          })
      ),
    testLimit(20_000)
  );

  it.live(
    "stop waits for the step in flight, which commits once",
    () => {
      const held = Promise.withResolvers<boolean>();
      const gate = { entered: false };

      return withBrain(
        [
          reactor(
            "slow",
            { events: ["workflow.node.settled"], from: "start" },
            async (tx, event) => {
              gate.entered = true;
              // A test-only stall inside the commit: what stop must wait out.
              await held.promise;
              await record(tx, "slow", event.id);
            }
          ),
        ],
        (context) =>
          Effect.gen(function* () {
            const brain = Context.get(context, Brain);
            const reactors = Context.get(context, EventReactors);

            yield* reactors.start;

            const id = yield* emitOne(brain, settled(OCTOBER, 1));

            assert.isTrue(yield* eventually(Effect.sync(() => gate.entered)));

            const stopped = { value: false };

            const stopping = yield* reactors.stop.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  stopped.value = true;
                })
              ),
              Effect.forkScoped
            );

            yield* Effect.sleep(Duration.millis(300));
            assert.isFalse(stopped.value, "stop did not wait for the step");

            held.resolve(true);
            yield* Fiber.join(stopping);

            const seen = yield* readSeen(brain);
            const state = yield* readEvents(brain);

            assert.deepStrictEqual(seen.handled.slow, [id]);
            assert.strictEqual(state.cursors.slow?.entryId, id);
          })
      );
    },
    testLimit(20_000)
  );

  it.live("an empty, padded or repeated reactor name makes the layer die", () =>
    Effect.gen(function* () {
      for (const names of [[""], [" padded"], ["twice", "twice"]]) {
        const exit = yield* Effect.exit(
          withBrain(names.map(named), () => Effect.void)
        );

        assert.isTrue(Exit.isFailure(exit), `${names.join(",")} built`);

        if (Exit.isFailure(exit)) {
          assert.include(
            Cause.pretty(exit.cause),
            "is empty, padded or used twice"
          );
        }
      }
    })
  );
});
