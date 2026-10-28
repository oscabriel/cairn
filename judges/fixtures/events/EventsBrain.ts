// The judge brain of `judges/events-kill.ts` (ADR 0033): Cairn's own `Brain` over a store in the
// run's directory, the production reactor host (`ReactorSet.withExtra`) with three judge reactors,
// and a producer that emits one event per commit. The orchestrator `kill -9`s it again and again;
// the last life runs to the end, then writes `report.json` and exits.
//
//   node judges/fixtures/events/EventsBrain.ts --dir <run> --total N [--faults] [--rotate] [--control]
//
// - Producer: event n is `workflow.node.refused` when n % 3 == 0, `workflow.budget.soft` when
//   n % 4 == 0, else `workflow.node.settled`; the commit that emits it also records it in the judge
//   document, so the expected set is exactly what the log holds. With `--rotate` the first half is
//   stamped in one month and the second half in the next, so the log rotates mid-run (the host's
//   start opened the first log in the current month, so that is two rotations).
// - Reactors, each writing through `tx` only: `judge.count` (settled, refused) and `judge.meter`
//   (settled) count each event they handle; `judge.spawn` (settled, budget.soft) counts and creates
//   a `judge.record-run` task, which appends a line to `effects.log` (an outside effect, at least
//   once) and counts its run in its terminal commit (exactly once).
// - `--faults`: each reactor writes, then throws, on its own residue class of event ids, once per
//   event per process (`faults.log` gets a line each time), so the rollback must take the write.
// - `--control`: the broken control. The same reactors run without the host: each keeps its cursor
//   in memory and moves it after its handler's commit, so every life starts over at the log's start.
//
// Prints `from <n>` (the events emitted before this life) and `producing` once the producer
// runs, and `done` after the report.

import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { ConversationId } from "@cairn/protocol/Ids";
import type { EventName } from "@cairn/protocol/Workflows";
import type { JsonValue } from "@earendil-works/chord";
import type { Tx } from "@earendil-works/pi-durable";
import {
  defineDoc,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { NodeRuntime } from "@effect/platform-node";
import { Console, Duration, Effect, Layer, Option } from "effect";

import { Arms } from "../../../apps/server/src/brain/Arms.ts";
import { Brain } from "../../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../../apps/server/src/brain/BrainConfig.ts";
import { BrainStore } from "../../../apps/server/src/brain/BrainStore.ts";
import { durable } from "../../../apps/server/src/brain/Durable.ts";
import { EventReactors } from "../../../apps/server/src/brain/EventReactors.ts";
import type {
  EventCursorState,
  Reactor,
} from "../../../apps/server/src/brain/Events.ts";
import {
  emit,
  EventsDoc,
  nextPending,
  reactor,
  reactorKinds,
} from "../../../apps/server/src/brain/Events.ts";
import {
  ExtensionOrder,
  Extensions,
} from "../../../apps/server/src/brain/Extensions.ts";
import { ModelSource } from "../../../apps/server/src/brain/ModelSource.ts";
import { Parked } from "../../../apps/server/src/brain/Parked.ts";
import { piConversationId } from "../../../apps/server/src/brain/PiIds.ts";
import { ReactorSet } from "../../../apps/server/src/brain/ReactorSet.ts";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    total: { type: "string", default: "300" },
    faults: { type: "boolean", default: false },
    rotate: { type: "boolean", default: false },
    control: { type: "boolean", default: false },
  },
});

const dir = path.resolve(values.dir ?? ".");

const total = Number(values.total);

/** Milliseconds between two produced events. */
const PRODUCE_EVERY = 10;

/** The judge's own record, written only through `tx` by the producer, the reactors and the task. */
interface JudgeState {
  [key: string]: JsonValue;
  emitted: number;
  /** Every event emitted: entry id to event name. */
  events: { [id: string]: string };
  /** Per reactor, entry id to the times it was handled. */
  handled: { [reactor: string]: { [id: string]: number } };
  /** Tasks `judge.spawn` created, and the times each ran to its end, by entry id. */
  created: { [id: string]: number };
  ran: { [id: string]: number };
  /** The conversation the created tasks live in; 0 until the first. */
  home: number;
}

const JudgeDoc = defineDoc<JudgeState>({
  kind: "cairn.judge-events",
  version: 1,
  scope: "session",
  initial: () => ({
    emitted: 0,
    events: {},
    handled: {},
    created: {},
    ran: {},
    home: 0,
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 50,
});

const effectsLog = path.join(dir, "effects.log");

const faultsLog = path.join(dir, "faults.log");

/** The task `judge.spawn` creates: one outside effect, then its run counted in its last commit. */
const RecordRun = defineTask<
  { readonly eventId: number },
  { readonly phase: "run" },
  number
>({
  name: "judge.record-run",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      appendFileSync(effectsLog, `${task.input.eventId}\n`);
      await runtime.commit(async (tx) => {
        const state = await tx.doc(JudgeDoc);
        const key = String(task.input.eventId);

        state.ran[key] = (state.ran[key] ?? 0) + 1;

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

const JudgeTasks = defineExtension({
  name: "judge.events",
  tasks: [RecordRun],
});

/** Event ids each reactor has already failed on in this process. */
const failedOnce = new Map<string, Set<number>>();

/** Writes, then throws on the reactor's residue class, once per event per process. */
const fault = (name: string, modulus: number, id: number) => {
  if (!values.faults || id % modulus !== 0) {
    return;
  }

  const seen = failedOnce.get(name) ?? new Set<number>();

  failedOnce.set(name, seen);

  if (seen.has(id)) {
    return;
  }

  seen.add(id);
  appendFileSync(faultsLog, `${name} ${id}\n`);

  throw new Error(`injected fault: ${name} on ${id}`);
};

const count = async (tx: Tx, name: string, id: number) => {
  const state = await tx.doc(JudgeDoc);
  const counts = state.handled[name] ?? {};

  counts[String(id)] = (counts[String(id)] ?? 0) + 1;
  state.handled[name] = counts;
};

const reactors: ReadonlyArray<Reactor> = [
  reactor(
    "judge.count",
    {
      events: ["workflow.node.settled", "workflow.node.refused"],
      from: "start",
    },
    async (tx, event) => {
      await count(tx, "judge.count", event.id);
      fault("judge.count", 7, event.id);
    }
  ),
  reactor(
    "judge.meter",
    { events: ["workflow.node.settled"], from: "start" },
    async (tx, event) => {
      await count(tx, "judge.meter", event.id);
      fault("judge.meter", 5, event.id);
    }
  ),
  reactor(
    "judge.spawn",
    {
      events: ["workflow.node.settled", "workflow.budget.soft"],
      from: "start",
    },
    async (tx, event) => {
      const state = await tx.doc(JudgeDoc);
      let { home } = state;

      if (home === 0) {
        const created = await tx.createConversation({
          ownership: { kind: "ownerless" },
        });

        home = created.id;
        state.home = home;
      }

      const key = String(event.id);

      state.created[key] = (state.created[key] ?? 0) + 1;
      await tx.createTask(
        RecordRun,
        { eventId: event.id },
        {
          ownership: { kind: "conversation" },
          conversationId: piConversationId(ConversationId.make(home)),
          background: true,
        }
      );
      await count(tx, "judge.spawn", event.id);
      fault("judge.spawn", 11, event.id);
    }
  ),
];

const nameOf = (n: number): EventName => {
  if (n % 3 === 0) {
    return "workflow.node.refused";
  }

  return n % 4 === 0 ? "workflow.budget.soft" : "workflow.node.settled";
};

/** Far ahead of any real clock, so both stamps rotate whatever month the judge runs in. */
const FIRST_MONTH = Date.parse("2999-10-15T12:00:00Z");

const SECOND_MONTH = Date.parse("2999-11-15T12:00:00Z");

const hostLayer = values.control
  ? EventReactors.fromSources<never, never>([])
  : ReactorSet.withExtra(reactors);

const JudgeLayer = hostLayer.pipe(
  Layer.provideMerge(
    Brain.layerNoDeps.pipe(
      Layer.provide(BrainStore.layer),
      Layer.provide(Arms.layer)
    )
  ),
  Layer.provide(Parked.layer),
  Layer.provide(
    Extensions.fromSources([
      Effect.succeed({ order: ExtensionOrder.judge, extension: JudgeTasks }),
    ])
  ),
  Layer.provide(
    ModelSource.layerFaux({
      tokensPerSecond: 2000,
      settings: { retry: { enabled: false } },
    })
  ),
  Layer.provide(BrainConfig.layerFrom(dir))
);

const program = Effect.gen(function* () {
  const brain = yield* Brain;
  const host = yield* EventReactors;

  const commit = <A>(operation: string, change: (tx: Tx) => Promise<A>) =>
    Effect.flatMap(brain.session, (session) =>
      durable(
        operation,
        async (context) => await session.harness.commit(change, context)
      )
    );

  // Committed copies, read outside any commit (drafts cannot be cloned).
  const read = Effect.flatMap(brain.session, (session) =>
    durable("judge.read", async (context) => {
      const state = await session.harness.snapshot(JudgeDoc, context);
      const events = await session.harness.snapshot(EventsDoc, context);

      return {
        state: state ?? JudgeDoc.definition.initial(),
        events: events ?? EventsDoc.definition.initial(),
      };
    })
  );

  // Boot: the reactors start after the repairs, then the Harness resumes.
  yield* host.start;
  yield* brain.resume;

  // The broken control: cursors in memory, moved after the handler's commit.
  if (values.control) {
    const start = yield* commit("control.start", async (tx) => {
      const state = await tx.doc(EventsDoc);

      return state.logConversationId;
    });

    for (const target of reactors) {
      const kinds = reactorKinds(target);

      let cursor: Option.Option<EventCursorState> = Option.map(
        Option.fromNullOr(start),
        (log) => ({ logConversationId: log, entryId: null })
      );

      const once = Effect.gen(function* () {
        if (Option.isNone(cursor)) {
          const log = yield* commit("control.log", async (tx) => {
            const state = await tx.doc(EventsDoc);

            return state.logConversationId;
          });

          cursor = Option.map(Option.fromNullOr(log), (id) => ({
            logConversationId: id,
            entryId: null,
          }));

          return;
        }

        const from = cursor.value;

        const step = yield* commit("control.step", async (tx) => {
          const pending = await nextPending(tx, from, kinds);

          if (Option.isSome(pending.event)) {
            await target.handle(tx, pending.event.value);
          }

          return pending.cursor;
        });

        cursor = Option.some(step);
      });

      yield* once.pipe(
        Effect.ignore,
        Effect.andThen(Effect.sleep(Duration.millis(5))),
        Effect.forever,
        Effect.forkScoped
      );
    }
  }

  const before = yield* read;

  // How far the log got before this life, then the line the orchestrator waits for.
  yield* Console.log(`from ${before.state.emitted}`);
  yield* Console.log("producing");

  // The producer: one event per commit, recorded with it, until `total` exist.
  for (;;) {
    const emitted = yield* commit("judge.produce", async (tx) => {
      const state = await tx.doc(JudgeDoc);

      if (state.emitted >= total) {
        return state.emitted;
      }

      const n = state.emitted + 1;

      let at = brain.now();

      if (values.rotate) {
        at = n <= total / 2 ? FIRST_MONTH : SECOND_MONTH;
      }

      const event = await emit(tx, {
        name: nameOf(n),
        data: { n },
        at,
        context: Option.none(),
      });

      state.events[String(event.id)] = event.name;
      state.emitted = n;

      return n;
    });

    if (emitted >= total) {
      break;
    }

    yield* Effect.sleep(Duration.millis(PRODUCE_EVERY));
  }

  // Wait until every reactor caught up and every created task ran.
  for (;;) {
    const status = yield* host.status;

    const judge = yield* read;

    const tasksDone =
      Object.keys(judge.state.created).every(
        (id) => judge.state.ran[id] !== undefined
      ) && Object.keys(judge.state.handled["judge.spawn"] ?? {}).length > 0;

    const caughtUp = values.control
      ? Object.keys(judge.state.handled).length === reactors.length
      : status.reactors.every((each) => each.lag === 0);

    yield* Console.error(
      JSON.stringify({
        waiting: {
          lag: status.reactors.map((each) => each.lag),
          created: Object.keys(judge.state.created).length,
          ran: Object.keys(judge.state.ran).length,
        },
      })
    );

    if (caughtUp && tasksDone) {
      // The control has no lag to read; give its loops a moment to drain.
      if (values.control) {
        yield* Effect.sleep(Duration.seconds(2));
      }

      const final = yield* read;

      writeFileSync(
        path.join(dir, "report.json"),
        JSON.stringify({
          judge: final.state,
          events: final.events,
          status: status.reactors.map((each) => ({
            reactor: each.reactor,
            lag: each.lag,
            failuresInARow: each.failuresInARow,
          })),
        })
      );

      yield* Console.log("done");

      return;
    }

    yield* Effect.sleep(Duration.millis(200));
  }
});

NodeRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(JudgeLayer), Effect.orDie)
);
