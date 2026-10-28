// The reactor host (ADR 0033): runs every registered reactor over the durable event log
// (`Events.ts`), one event per commit, serially per reactor and independently across reactors.
//
// - Wakes: a commit that appends one of a reactor's events (or rotates the log) wakes it; so does
//   each Session as it opens (boot, and every reopen after a storage failure). The commit listener
//   only offers to a one-slot queue, because pi-durable calls it on the mutation line.
// - Steps: one commit per event (`reactOnce`). A step that throws rolls back with its cursor; the
//   reactor records the failure, waits (100 ms doubling to 30 s) and tries again, and a commit or a
//   reopen in between wakes it sooner. A closed Harness is not a failure: the next Session wakes it.
// - Lifetime: nothing runs before `start`, which boot calls after its other repairs and before the
//   brain is ready. It first gives every reactor without a cursor one at the start of the current
//   log (`registerCursors`), so a reactor misses nothing from its first boot on. `stop` runs among
//   the close hooks, before the Harness closes, and waits for the step in flight (each step is
//   uninterruptible: it is one commit).
// - Status: per reactor, the events after its cursor (counted in a read-only commit), and the last
//   success and failure this process saw. A reactor that fails `FAILING_AFTER` times in a row logs
//   `event_reactor_failing`.

import { EntryId } from "@cairn/protocol/Ids";
import type { EventStatus, ReactorStatus } from "@cairn/protocol/Workflows";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  FiberSet,
  Layer,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";

import type { BootRepair } from "../BootRepairs.ts";
import { shutdownHook } from "../Shutdown.ts";
import { Brain } from "./Brain.ts";
import type { BrainUnavailable } from "./Brain.ts";
import { durable } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import type { EventRecord, Reactor } from "./Events.ts";
import {
  isLogEntryKind,
  lagOf,
  reactOnce,
  registerCursors,
  reactorKinds,
  wakesFor,
} from "./Events.ts";

/** Failures in a row after which a reactor logs `event_reactor_failing`. */
export const FAILING_AFTER = 3;

/** Events counted per reactor for its lag; a lag this large means "at least". */
export const LAG_LIMIT = 100_000;

const RETRY_FIRST = Duration.millis(100);

const RETRY_MAX = Duration.seconds(30);

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** The wait before the next try after `failures` failed steps in a row (at least one). */
const retryAfter = (failures: number) =>
  Duration.min(
    Duration.times(RETRY_FIRST, 2 ** Math.min(failures - 1, 16)),
    RETRY_MAX
  );

/** One reactor step's commit failed; it rolled back, cursor and all. */
export class ReactorStepFailed extends Schema.TaggedError<ReactorStepFailed>()(
  "ReactorStepFailed",
  {
    message: Schema.String,
    reactor: Schema.String,
    /** The event the handler was given, when the step got that far. */
    eventId: Schema.Option(EntryId),
    /** The Harness was closing: not the reactor's failure. */
    closed: Schema.Boolean,
  }
) {}

/** What this process knows of one reactor beyond its cursor. */
interface ReactorState {
  readonly reactor: Reactor;
  readonly kinds: ReadonlySet<string>;
  readonly wake: Queue.Queue<true>;
  lastHandledAt: Option.Option<number>;
  lastFailure: Option.Option<{ readonly at: number; readonly message: string }>;
  failuresInARow: number;
}

/** How one step or a drain ended. */
type StepEnd = "handled" | "idle" | "failed";

/**
 * Durable event reactors over the brain's event log. Needs `Brain`; `layerOff` is for brains with
 * no pi-durable Harness (the scripted dev brain), where no event is ever emitted.
 */
export class EventReactors extends Context.Service<
  EventReactors,
  {
    /** Starts every reactor; each first handles what is pending. Boot calls it once. Idempotent. */
    readonly start: Effect.Effect<void>;
    /** Stops every reactor after its step in flight. The close hook calls it. Idempotent. */
    readonly stop: Effect.Effect<void>;
    /** Each reactor's lag, last success and last failure, in registration order. */
    readonly status: Effect.Effect<
      EventStatus,
      BrainUnavailable | DurableCallError
    >;
  }
>()("cairn/server/brain/EventReactors") {
  /**
   * The host over the reactors `sources` build. An empty, padded or repeated reactor name is a
   * wiring bug, so the layer dies naming it.
   */
  static readonly fromSources = <E, R>(
    sources: ReadonlyArray<Effect.Effect<Reactor, E, R>>
  ) =>
    Layer.effect(
      EventReactors,
      Effect.gen(function* () {
        const brain = yield* Brain;
        const reactors = yield* Effect.all(sources);
        const names = new Set<string>();

        for (const { name } of reactors) {
          if (name.trim() === "" || name.trim() !== name || names.has(name)) {
            return yield* Effect.die(
              `The event reactor name "${name}" is empty, padded or used twice. Give each reactor its own trimmed name.`
            );
          }

          names.add(name);
        }

        const states: ReadonlyArray<ReactorState> = yield* Effect.forEach(
          reactors,
          (target) =>
            Effect.map(Queue.sliding<true>(1), (wake): ReactorState => ({
              reactor: target,
              kinds: reactorKinds(target),
              wake,
              lastHandledAt: Option.none(),
              lastFailure: Option.none(),
              failuresInARow: 0,
            }))
        );

        const wakeAll = Effect.sync(() => {
          for (const state of states) {
            Queue.offerUnsafe(state.wake, true);
          }
        });

        // Synchronous on pi-durable's mutation line: it only offers wakes.
        yield* brain.subscribeCommits((_session, publication) => {
          for (const change of publication.changes) {
            if (change.type === "entry" && isLogEntryKind(change.value.kind)) {
              for (const state of states) {
                if (wakesFor(change.value.kind, state.kinds)) {
                  Queue.offerUnsafe(state.wake, true);
                }
              }
            }
          }
        });

        const fibers = yield* FiberSet.make();
        let running = false;

        /** One commit: the next pending event handled, or none. Never interrupted halfway. */
        const step = (state: ReactorState) =>
          Effect.gen(function* () {
            const session = yield* brain.session;
            const attempted = { event: Option.none<EventRecord>() };

            return yield* durable(
              "events.react",
              async (context) =>
                await session.harness.commit(
                  async (tx) =>
                    await reactOnce(tx, state.reactor, state.kinds, (event) => {
                      attempted.event = Option.some(event);
                    }),
                  context
                )
            ).pipe(
              Effect.mapError(
                (failure) =>
                  new ReactorStepFailed({
                    message: failure.message,
                    reactor: state.reactor.name,
                    eventId: Option.map(attempted.event, (event) => event.id),
                    closed: failure.closed,
                  })
              )
            );
          }).pipe(Effect.uninterruptible);

        const recordFailure = Effect.fn("EventReactors.recordFailure")(
          function* (state: ReactorState, failed: ReactorStepFailed) {
            state.failuresInARow += 1;
            state.lastFailure = Option.some({
              at: brain.now(),
              message: failed.message,
            });

            const annotations = {
              event: "event_reactor_failed",
              reactor: state.reactor.name,
              failuresInARow: state.failuresInARow,
              eventId: Option.match(failed.eventId, {
                onNone: () => "none",
                onSome: String,
              }),
              error: failed.message,
            };

            yield* Effect.logWarning("event reactor step failed").pipe(
              Effect.annotateLogs(annotations)
            );

            if (state.failuresInARow === FAILING_AFTER) {
              yield* Effect.logError("event reactor keeps failing").pipe(
                Effect.annotateLogs({
                  ...annotations,
                  event: "event_reactor_failing",
                })
              );
            }
          }
        );

        /** One step, its outcome recorded. */
        const stepOnce = (state: ReactorState) =>
          step(state).pipe(
            Effect.map((handled): StepEnd => {
              if (Option.isNone(handled)) {
                return "idle";
              }

              state.lastHandledAt = Option.some(brain.now());
              state.failuresInARow = 0;

              return "handled";
            }),
            Effect.catchTags({
              // The brain is reopening or closing: the next Session wakes every reactor.
              BrainUnavailable: () => Effect.succeed<StepEnd>("idle"),
              ReactorStepFailed: (failed) =>
                failed.closed
                  ? Effect.succeed<StepEnd>("idle")
                  : Effect.as(recordFailure(state, failed), "failed" as const),
            })
          );

        /** Steps until nothing is pending, the brain is down, or a step fails. */
        const drain = (state: ReactorState) =>
          Effect.gen(function* () {
            let end: StepEnd = "handled";

            while (end === "handled") {
              end = yield* stepOnce(state);
            }

            return end;
          });

        const loop = (state: ReactorState) =>
          Effect.gen(function* () {
            for (;;) {
              yield* Queue.take(state.wake);

              const end = yield* drain(state);

              // The wait doubles with each failure in a row; a handled event resets the count.
              if (end === "failed") {
                yield* Effect.sleep(retryAfter(state.failuresInARow));
                Queue.offerUnsafe(state.wake, true);
              }
            }
          }).pipe(Effect.annotateLogs({ reactor: state.reactor.name }));

        const start = Effect.gen(function* () {
          if (running) {
            return;
          }

          running = true;

          // Every reactor gets its cursor now, so none misses an event emitted from here on.
          yield* brain.session.pipe(
            Effect.flatMap((session) =>
              durable("events.register", async (context) => {
                await session.harness.commit(async (tx) => {
                  await registerCursors(tx, [...names], brain.now());
                }, context);
              })
            ),
            Effect.catchTags({
              BrainUnavailable: (failure) =>
                Effect.logError("event reactor cursors not registered").pipe(
                  Effect.annotateLogs({
                    event: "event_reactors_register_failed",
                    error: failure.message,
                  })
                ),
              DurableCallError: (failure) =>
                Effect.logError("event reactor cursors not registered").pipe(
                  Effect.annotateLogs({
                    event: "event_reactors_register_failed",
                    error: failure.message,
                  })
                ),
            })
          );

          for (const state of states) {
            yield* FiberSet.run(fibers, loop(state));
          }

          // Each Session as it opens (the current one first) wakes every reactor.
          yield* FiberSet.run(
            fibers,
            Stream.runForEach(brain.sessions, () => wakeAll)
          );

          yield* Effect.logInfo("event reactors started").pipe(
            Effect.annotateLogs({
              event: "event_reactors_started",
              reactors: states.length,
            })
          );
        });

        const stop = Effect.gen(function* () {
          if (!running) {
            return;
          }

          running = false;
          yield* FiberSet.clear(fibers);
        });

        const status = Effect.gen(function* () {
          const session = yield* brain.session;

          const lags = yield* durable(
            "events.status",
            async (context) =>
              await session.harness.commit(async (tx) => {
                const counted: Array<number> = [];

                for (const state of states) {
                  counted.push(
                    // oxlint-disable-next-line no-await-in-loop -- one read commit, reactors in order
                    await lagOf(tx, state.reactor, state.kinds, LAG_LIMIT)
                  );
                }

                return counted;
              }, context)
          );

          const reactorsStatus = states.map((state, index): ReactorStatus => ({
            reactor: state.reactor.name,
            lag: lags[index] ?? 0,
            lastHandledAt: Option.map(state.lastHandledAt, at),
            lastFailure: Option.map(state.lastFailure, (failure) => ({
              at: at(failure.at),
              message: failure.message,
            })),
            failuresInARow: state.failuresInARow,
          }));

          return { reactors: reactorsStatus };
        }).pipe(Effect.withSpan("EventReactors.status"));

        return EventReactors.of({ start, stop, status });
      })
    );

  /** No reactors and no log: for the scripted brain, which emits no events. */
  static readonly layerOff = Layer.succeed(
    EventReactors,
    EventReactors.of({
      start: Effect.void,
      stop: Effect.void,
      status: Effect.succeed({ reactors: [] }),
    })
  );
}

/** The boot repair that starts the reactors; listed last, after every other repair. */
export const startEventReactors: BootRepair<EventReactors> = {
  name: "start event reactors",
  repair: EventReactors.use((reactors) => reactors.start),
};

/** The close hook that stops the reactors before the Harness closes. */
export const stopEventReactors = shutdownHook(
  "stop event reactors",
  EventReactors.use((reactors) => reactors.stop)
);
