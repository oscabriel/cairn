// The reactor host (ADR 0033): runs every registered reactor over the event conversation
// (`Events.ts`), one event per commit, serially per reactor and independently across reactors.
//
// - Wakes: a commit that appends one of a reactor's events (or rotates the log) wakes it; so does
//   each Session as it opens (boot, and every reopen after a storage failure). The commit listener
//   only offers to a one-slot queue, because pi-durable calls it on the mutation line.
// - Steps: one commit per event (`reactOnce`). A step that throws rolls back with its cursor; the
//   reactor records the failure and retries on its timer (100 ms doubling to 30 s). Wakes during
//   the backoff are coalesced into the retry, never acted on sooner, so a poison event cannot spin.
//   A closed Harness is not a failure: the next Session wakes it.
// - Poison (ADR 0033 as amended): after `DEAD_LETTER_AFTER` failed steps in a row on one event, or
//   at once when the step threw `UnreadableEvent` (no retry can read it), the host passes the event
//   in one commit that moves the cursor and writes a dead letter with the error (`deadLetter`), and
//   the reactor goes on to the next event. Each dead letter is logged (`event_dead_lettered`),
//   shows in the status as the reactor's last failure (read back from the letters after a
//   restart), and is pushed through `push` (the outbox gathers a run of them into one push). The
//   pass, its log line and its push are one uninterruptible piece, as a step is.
// - Lifetime: nothing runs before `start`, which boot calls after its other repairs and before the
//   brain is ready. It first gives every reactor without a cursor one in the current log, at its
//   tail or its start as the reactor's `from` says (`registerCursors`), so a reactor misses nothing
//   emitted from its first boot on. `stop` runs among
//   the close hooks, before the Harness closes, and waits for the step in flight (each step is
//   uninterruptible: it is one commit).
// - Status: per reactor, the events after its cursor (counted in a read-only commit), the last
//   success this process saw, and the last failure: this process's, or the reactor's last dead
//   letter when that is newer. A reactor that fails `FAILING_AFTER` times in a row logs
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
import type { DeadLetterState, EventRecord, Reactor } from "./Events.ts";
import {
  deadLetter,
  DeadLettersDoc,
  isLogEntryKind,
  lagOf,
  reactOnce,
  registerCursors,
  reactorKinds,
  UnreadableEvent,
  wakesFor,
} from "./Events.ts";

/** Failures in a row after which a reactor logs `event_reactor_failing`. */
export const FAILING_AFTER = 3;

/**
 * Failed steps on one event after which the host dead-letters it: five tries over about 1.5 s of
 * backoff (100, 200, 400 and 800 ms between them). A handler reads only `tx` and the event, so its
 * throw repeats unless a commit in between changed what it reads, and such a commit lands in that
 * window or not at all; a storage failure closes the Session and is not counted. Every try past
 * that only holds back each later event of the reactor (for the budget reactor, the stop and raise
 * of every workflow at its line). The count is this process's: a restart gives an event five more.
 */
export const DEAD_LETTER_AFTER = 5;

/** Where the host hands a dead letter for its push; never fails, never waits for delivery. */
export type DeadLetterPush = (letter: DeadLetterState) => Effect.Effect<void>;

/** A push that sends nothing: a brain with no notifier, and tests. */
export const NO_DEAD_LETTER_PUSH: DeadLetterPush = () => Effect.void;

/** Events counted per reactor for its lag; a lag this large means "at least". */
export const LAG_LIMIT = 100_000;

const RETRY_FIRST = Duration.millis(100);

const RETRY_MAX = Duration.seconds(30);

const at = (millis: number) => DateTime.makeUnsafe(millis);

/** The longest failure message status carries: the protocol's `DisplayText` limit. */
const MESSAGE_LIMIT = 4096;

/** `message` cut to `MESSAGE_LIMIT` characters, marked when cut. */
export const boundedMessage = (message: string) =>
  message.length <= MESSAGE_LIMIT
    ? message
    : `${message.slice(0, MESSAGE_LIMIT - 1)}…`;

/** The wait before the next try after `failures` failed steps in a row (at least one). */
const retryAfter = (failures: number) =>
  Duration.min(
    Duration.times(RETRY_FIRST, 2 ** Math.min(failures - 1, 16)),
    RETRY_MAX
  );

/** A dead letter's status line: which event was passed, after how many failed steps, and why. */
const letterLine = (letter: DeadLetterState) =>
  boundedMessage(
    `Dead-lettered event ${String(letter.eventId)} (${letter.kind}) after ${String(letter.failures)} failed step${letter.failures === 1 ? "" : "s"}: ${letter.error}`
  );

/** The newest dead letter of `reactorName` among `letters`; none when it has none. */
const lastLetterOf = (
  letters: ReadonlyArray<DeadLetterState>,
  reactorName: string
): Option.Option<DeadLetterState> => {
  let newest: DeadLetterState | undefined;

  for (const letter of letters) {
    if (
      letter.reactor === reactorName &&
      (newest === undefined || letter.at >= newest.at)
    ) {
      newest = letter;
    }
  }

  return Option.fromUndefinedOr(newest);
};

interface Failure {
  readonly at: number;
  readonly message: string;
}

/** The newer of two failures; a tie goes to this process's own. */
const newerFailure = (
  own: Option.Option<Failure>,
  letter: Option.Option<Failure>
): Option.Option<Failure> =>
  Option.isSome(own) && Option.isSome(letter) && letter.value.at > own.value.at
    ? letter
    : Option.orElse(own, () => letter);

/** One reactor step's commit failed; it rolled back, cursor and all. */
export class ReactorStepFailed extends Schema.TaggedError<ReactorStepFailed>()(
  "ReactorStepFailed",
  {
    message: Schema.String,
    reactor: Schema.String,
    /**
     * The event the step failed on: the one the handler was given, or the entry `UnreadableEvent`
     * names when the step could not read it; none when it failed before any event.
     */
    eventId: Schema.Option(EntryId),
    /** The step threw `UnreadableEvent`: no retry can read the event. */
    unreadable: Schema.Boolean,
    /** The Harness was closing: not the reactor's failure. */
    closed: Schema.Boolean,
    cause: Schema.Defect(),
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
  /** The event the failures in a row are on, and how many there were on it. */
  poison: Option.Option<{
    readonly eventId: EntryId;
    readonly failures: number;
  }>;
}

/** How one step or a drain ended. */
type StepEnd = "handled" | "idle" | "failed";

/** The `UnreadableEvent` a failed commit threw, if that is what it threw. */
const unreadableOf = (cause: unknown): Option.Option<UnreadableEvent> =>
  cause instanceof UnreadableEvent ? Option.some(cause) : Option.none();

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
   * The host over the reactors `sources` build, pushing each dead letter through the sink `push`
   * builds (none by default). An empty, padded or repeated reactor name is a wiring bug, so the
   * layer dies naming it.
   */
  static readonly fromSources = <E, R, R2 = never>(
    sources: ReadonlyArray<Effect.Effect<Reactor, E, R>>,
    push: Effect.Effect<DeadLetterPush, never, R2> = Effect.succeed(
      NO_DEAD_LETTER_PUSH
    )
  ) =>
    Layer.effect(
      EventReactors,
      Effect.gen(function* () {
        const brain = yield* Brain;
        const reactors = yield* Effect.all(sources);
        const pushLetter = yield* push;
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
              poison: Option.none(),
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
              Effect.mapError((failure) => {
                const unreadable = unreadableOf(failure.cause);

                return new ReactorStepFailed({
                  message: failure.message,
                  reactor: state.reactor.name,
                  eventId: Option.orElse(
                    Option.map(attempted.event, (event) => event.id),
                    () => Option.map(unreadable, (found) => found.eventId)
                  ),
                  unreadable: Option.isSome(unreadable),
                  closed: failure.closed,
                  cause: failure.cause,
                });
              })
            );
          }).pipe(Effect.uninterruptible);

        const recordFailure = Effect.fn("EventReactors.recordFailure")(
          function* (state: ReactorState, failed: ReactorStepFailed) {
            state.failuresInARow += 1;
            state.poison = Option.map(failed.eventId, (eventId) => ({
              eventId,
              failures: Option.match(
                Option.filter(state.poison, (on) => on.eventId === eventId),
                { onNone: () => 1, onSome: (on) => on.failures + 1 }
              ),
            }));
            state.lastFailure = Option.some({
              at: brain.now(),
              message: boundedMessage(failed.message),
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

        /**
         * Passes the event the reactor keeps failing on, in one commit (`deadLetter`), then logs,
         * records and pushes the letter, all uninterruptible as a step is, so a stop never leaves a
         * letter written without its log line and push. "handled" either way, so the reactor goes
         * on at once: the event was passed, or the cursor had already left it.
         */
        const passPoison = Effect.fn("EventReactors.passPoison")(function* (
          state: ReactorState,
          eventId: EntryId,
          failures: number,
          error: string
        ) {
          const session = yield* brain.session;
          const passedAt = brain.now();

          const passed = yield* durable(
            "events.dead-letter",
            async (context) =>
              await session.harness.commit(
                async (tx) =>
                  await deadLetter(tx, state.reactor, state.kinds, {
                    eventId,
                    error: boundedMessage(error),
                    failures,
                    at: passedAt,
                  }),
                context
              )
          );

          state.poison = Option.none();

          for (const letter of Option.toArray(passed)) {
            state.failuresInARow = 0;
            state.lastFailure = Option.some({
              at: passedAt,
              message: letterLine(letter),
            });

            yield* Effect.logError("event reactor dead-lettered an event").pipe(
              Effect.annotateLogs({
                event: "event_dead_lettered",
                reactor: state.reactor.name,
                eventId: letter.eventId,
                kind: letter.kind,
                failures,
                error: letter.error,
              })
            );

            yield* pushLetter(letter);
          }

          return "handled" as const;
        }, Effect.uninterruptible);

        /**
         * After a failed step: the event dead-lettered when it is poison, else a failed end. When
         * the dead letter's own commit fails, the event stays pending and the next try counts on
         * from here; a closing Harness is not a failure.
         */
        const afterFailure = Effect.fn("EventReactors.afterFailure")(
          function* (state: ReactorState, failed: ReactorStepFailed) {
            yield* recordFailure(state, failed);

            const poison = Option.filter(
              state.poison,
              (on) => failed.unreadable || on.failures >= DEAD_LETTER_AFTER
            );

            if (Option.isNone(poison)) {
              return "failed" as const;
            }

            return yield* passPoison(
              state,
              poison.value.eventId,
              poison.value.failures,
              failed.message
            );
          },
          Effect.catchTags({
            BrainUnavailable: () => Effect.succeed<StepEnd>("idle"),
            DurableCallError: (failure) =>
              failure.closed
                ? Effect.succeed<StepEnd>("idle")
                : Effect.as(
                    Effect.logWarning(
                      "event reactor could not dead-letter an event"
                    ).pipe(
                      Effect.annotateLogs({
                        event: "event_dead_letter_failed",
                        error: failure.message,
                      })
                    ),
                    "failed" as const
                  ),
          })
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
              state.poison = Option.none();

              return "handled";
            }),
            Effect.catchTags({
              // The brain is reopening or closing: the next Session wakes every reactor.
              BrainUnavailable: () => Effect.succeed<StepEnd>("idle"),
              ReactorStepFailed: (failed) =>
                failed.closed
                  ? Effect.succeed<StepEnd>("idle")
                  : afterFailure(state, failed),
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
                  await registerCursors(tx, reactors, brain.now());
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

          // The dead letters, so a reactor's last one shows after a restart too.
          const letters = yield* durable(
            "events.dead-letters",
            async (context) => {
              const held = await session.harness.snapshot(
                DeadLettersDoc,
                context
              );

              return Object.values(held?.items ?? {});
            }
          );

          const reactorsStatus = states.map((state, index): ReactorStatus => {
            const failure = newerFailure(
              state.lastFailure,
              Option.map(
                lastLetterOf(letters, state.reactor.name),
                (letter) => ({ at: letter.at, message: letterLine(letter) })
              )
            );

            return {
              reactor: state.reactor.name,
              lag: lags[index] ?? 0,
              lastHandledAt: Option.map(state.lastHandledAt, at),
              lastFailure: Option.map(failure, (each) => ({
                at: at(each.at),
                message: each.message,
              })),
              failuresInARow: state.failuresInARow,
            };
          });

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
