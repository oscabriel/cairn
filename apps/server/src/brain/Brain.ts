// The brain owns the one pi-durable Harness every thread runs in (ADR 0016).
//
// - Install: the extension set in its fixed order, once, before `Harness.open`.
// - Open does not schedule work. Boot runs its repairs and then `resume()`; a supervisor reopen
//   (below) resumes at once only once boot resumed, because then its repairs already ran. A reopen
//   before that waits for boot's `resume()`, which resumes whichever Session is open.
// - Supervisor: a storage error fails the Session, which closes itself (`closed` resolves
//   `failed`) and ends every watch `failed`. The supervisor reopens from storage with
//   backoff, and every client stream restarts from a fresh snapshot of the new Harness.
// - Commits: `subscribeCommits` listeners are attached to each Session as it opens (pi-durable's
//   `observeCommits`), before anything resumes it, so no commit of a resumed task is missed across a
//   reopen. pi-durable hands them stored commits only: streamed progress arrives with the next
//   commit that stores it, not one partial at a time.
// - Reports: `onReport` only enqueues; a fiber logs each report. pi-durable drops a throwing report
//   callback, so nothing here may throw.
// - Restarts: the Harness never ends a task for crashes (`RestartLimit`, ADR 0046); boot's
//   `crash limit` repair does Cairn's own crash accounting (`CrashLimit.ts`).
// - Reopens: each runs on its own fiber to its end; the supervisor waits for it at most
//   `BrainOpenTimeout`, or until the brain closes. A reopen it gave up on is cancelled, and what it
//   opened is closed as it lands: its storage at once if its Harness never opened, else the Harness
//   (and the storage with it). Close closes the storage of any still opening, so nothing a reopen
//   opened outlives the brain.
// - Close: on scope close, the supervisor stops first, so a reopen it was waiting for is given up
//   unless it already published its Session; then `harness.close` with a 5 s timeout. A task that
//   ignores its signal keeps close pending; past the timeout the process exits anyway and the task
//   counts one restart.
//
// Open and close follow cairn-v1, apps/server/src/Harnesses.ts at 1a5cd4a; the boot order comes
// from spikes/3-workflows/brain.ts and spikes/4-approvals/brain.ts in this repo.

import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type {
  CommitPublication,
  Report,
  ReportInfo,
  Storage,
} from "@earendil-works/pi-durable";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Function,
  Layer,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Cause, Scope } from "effect";

import { Arms } from "./Arms.ts";
import { BrainOpenTimeout } from "./BrainOpenTimeout.ts";
import { BrainStore } from "./BrainStore.ts";
import { durable, errorText } from "./Durable.ts";
import type { DurableCallError } from "./Durable.ts";
import { Extensions } from "./Extensions.ts";
import { ModelSource } from "./ModelSource.ts";
import { RestartLimit } from "./RestartLimit.ts";

/** How long shutdown waits for running tasks to stop. What still runs resumes as interrupted. */
const CLOSE_TIMEOUT = Duration.seconds(5);

/** The brain cannot serve: it is opening, reopening after a storage failure, or closing. */
export class BrainUnavailable extends Schema.TaggedError<BrainUnavailable>()(
  "BrainUnavailable",
  {
    message: Schema.String,
    state: Schema.Literals(["opening", "reopening", "closing"]),
  }
) {}

/** One open Harness and the storage under it. A reopen makes a new one. */
export interface BrainSession {
  readonly harness: Harness;
  /** For read-only scans the Harness does not offer. Closed with the Harness. */
  readonly storage: Storage;
  /** Counts opens in this process: 1 for the first, then one more per reopen. */
  readonly generation: number;
}

/**
 * Hears every commit of every Session. pi-durable calls it synchronously after each commit, so it
 * must only enqueue: no blocking and no calls back into the Harness.
 */
export type CommitListener = (
  session: BrainSession,
  publication: CommitPublication
) => void;

const reportFields = (info: ReportInfo) =>
  "task" in info && info.task !== undefined
    ? {
        type: info.kind,
        taskId: info.task.id,
        task: info.task.kind,
        conversationId: info.task.conversationId,
      }
    : { type: info.kind };

const reopenSchedule = Schedule.min([
  Schedule.exponential(Duration.millis(250)),
  Schedule.spaced(Duration.seconds(8)),
]);

/** What one open made, before it is published as a `BrainSession`. */
interface Opened {
  readonly storage: Storage;
  readonly harness: Harness;
}

/**
 * One open of a Session in flight. Plain mutable state, changed only in synchronous steps, so an
 * open landing and its waiter giving up on it never interleave.
 */
interface Opening {
  /** Cancels the Harness's open once its waiter gave up. */
  readonly cancel: AbortController;
  /** The storage, once the store opened it. */
  storage: Option.Option<Storage>;
  /** What the open made, once it finished and until its waiter takes it. */
  landed: Option.Option<Opened>;
  /** Set once nobody waits for the open: what it makes is closed as it lands. */
  abandoned: boolean;
}

const newOpening = (): Opening => ({
  cancel: new AbortController(),
  storage: Option.none(),
  landed: Option.none(),
  abandoned: false,
});

/** Logs a close that failed or ran past `CLOSE_TIMEOUT`; the process exits without it. */
const boundedClose = (
  what: string,
  close: Effect.Effect<void, DurableCallError>
) => {
  const unfinished = (failure: DurableCallError | Cause.TimeoutError) =>
    Effect.logWarning(`brain ${what} close did not finish`).pipe(
      Effect.annotateLogs({ error: errorText(failure) })
    );

  return close.pipe(
    Effect.timeout(CLOSE_TIMEOUT),
    Effect.catchTags({
      DurableCallError: unfinished,
      TimeoutError: unfinished,
    })
  );
};

/** Closes a Harness, and the storage under it. */
const closeHarness = (harness: Harness) =>
  boundedClose(
    "session",
    durable("close", async (context) => {
      await harness.close(context);
    })
  );

/** Closes storage no Harness will close; closing pi-durable storage twice closes it once. */
const closeStorage = (storage: Storage) =>
  boundedClose(
    "storage",
    durable("storage.close", async () => {
      await storage.close(BACKGROUND_CONTEXT);
    })
  );

/** The open Harness, its supervisor and its close. */
export class Brain extends Context.Service<
  Brain,
  {
    /** The open session; fails while the brain is down. */
    readonly session: Effect.Effect<BrainSession, BrainUnavailable>;
    /** Each session as it opens: the first, then one per reopen. */
    readonly sessions: Stream.Stream<BrainSession>;
    /**
     * Attaches a commit listener to the open Session and to every later one, each before it is
     * resumed. Detached when the scope closes.
     */
    readonly subscribeCommits: (
      listener: CommitListener
    ) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Lets the Harness schedule work, and every Session the supervisor reopens later. Boot calls it
     * after its repairs. Fails only once the brain is closing.
     */
    readonly resume: Effect.Effect<void, BrainUnavailable>;
    /** The Harness clock, epoch milliseconds. */
    now(): number;
  }
>()("cairn/server/brain/Brain") {
  static readonly layerNoDeps = Layer.effect(
    Brain,
    Effect.gen(function* () {
      const store = yield* BrainStore;
      const models = yield* ModelSource;
      const arms = yield* Arms;
      const extensions = yield* Extensions;
      const restartLimit = yield* RestartLimit;
      const clock = yield* Clock.Clock;

      const now = () => clock.currentTimeMillisUnsafe();

      const registry = createRegistry();

      for (const extension of extensions.installed) {
        registry.install(extension);
      }

      const reports = yield* Queue.unbounded<Report>();

      const logReport = Effect.fn("Brain.report")(function* (report: Report) {
        yield* Effect.logWarning("pi-durable report").pipe(
          Effect.annotateLogs({
            ...reportFields(report),
            error: errorText(report.error),
          })
        );
      });

      yield* Queue.take(reports).pipe(
        Effect.flatMap(logReport),
        Effect.forever,
        Effect.forkScoped
      );

      const current = yield* SubscriptionRef.make(Option.none<BrainSession>());
      const down = yield* Ref.make<BrainUnavailable["state"]>("opening");
      // Set by boot's `resume`, after its repairs: until then no Session schedules work.
      const resumed = yield* Ref.make(false);

      let generation = 0;

      // Plain mutable state on purpose: attaching to a new Session and registering a listener are
      // each one synchronous step, so neither can slip between the other's read and write.
      const listeners = new Set<CommitListener>();
      const detach = new Map<CommitListener, () => void>();

      const attach = (session: BrainSession, listener: CommitListener) => {
        const observation = session.harness.observeCommits({
          advance: (publication) => {
            listener(session, publication);
          },
          // The Session's close or failure; the supervisor hears it through `closed`.
          end: Function.constVoid,
        });

        detach.set(listener, () => {
          observation.detach();
        });
      };

      let latest: BrainSession | undefined;

      /**
       * Opens storage and a Harness over it; `opening.cancel` cancels the Harness's open. A failed
       * open leaves nothing open: pi-durable closes what a failed `Harness.open` made, the storage
       * with it, and the storage is closed here too for an open that failed before making its
       * Harness.
       */
      const openParts = (opening: Opening) =>
        Effect.gen(function* () {
          const storage = yield* store.open;

          opening.storage = Option.some(storage);

          // Given up while the store opened: the storage closes now, and the cancelled open fails.
          if (opening.abandoned) {
            yield* closeStorage(storage);
          }

          const harness = yield* durable(
            "open",
            async (context) =>
              await Harness.open(
                storage,
                {
                  models: () => models.models(),
                  settings: () => ({
                    ...models.settings(),
                    restartLimit,
                  }),
                  registry,
                  env: arms.env,
                  now,
                  // pi-durable calls this on its own stack; it only enqueues.
                  onReport: (report) => {
                    Queue.offerUnsafe(reports, report);
                  },
                },
                withAbortSignal(opening.cancel.signal, context)
              )
          ).pipe(Effect.tapError(() => closeStorage(storage)));

          return { storage, harness } satisfies Opened;
        });

      /** Makes what an open made the next Session, with every commit listener attached. */
      const land = Effect.fnUntraced(function* ({ storage, harness }: Opened) {
        const opened = yield* Effect.sync(() => {
          generation += 1;

          const session: BrainSession = { harness, storage, generation };

          // The old Session's listeners went with it; a closed Harness publishes nothing more.
          latest = session;

          for (const listener of listeners) {
            attach(session, listener);
          }

          return session;
        });

        yield* Effect.logInfo("brain session opened").pipe(
          Effect.annotateLogs({
            event: "brain_session_opened",
            generation: opened.generation,
          })
        );

        return opened;
      });

      const first = yield* openParts(newOpening()).pipe(
        Effect.flatMap(land),
        Effect.orDie
      );

      yield* SubscriptionRef.set(current, Option.some(first));

      // Every reopen still opening, or closing what it opened after its waiter gave up on it.
      const opening = new Set<Opening>();

      /** Closes what an open nobody waits for made, and forgets the open. */
      const closeLanded = (attempt: Opening, opened: Opened) =>
        closeHarness(opened.harness).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              opening.delete(attempt);
            })
          )
        );

      /**
       * Gives up on `attempt`: its open is cancelled, and what it made is closed, here if it
       * already landed, else as it lands. The flag and the read are one synchronous step, so the
       * landing cannot slip between them.
       */
      const abandon = (attempt: Opening) =>
        Effect.suspend(() => {
          attempt.abandoned = true;
          attempt.cancel.abort();

          return Option.match(attempt.landed, {
            onNone: () => Effect.void,
            onSome: (landed) => closeLanded(attempt, landed),
          });
        });

      // Added before the supervisor is forked, so on close the supervisor stops first: a reopen it
      // was waiting for is given up, unless it already published its Session. This closes whatever
      // Session is open, then gives up on every reopen still opening and closes the storage it
      // opened (its Harness, should one still open, closes as it lands).
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Ref.set(down, "closing");

          const open = yield* SubscriptionRef.getAndSet(current, Option.none());

          if (Option.isSome(open)) {
            yield* closeHarness(open.value.harness);
          }

          yield* Effect.forEach(
            [...opening],
            (attempt) =>
              Effect.andThen(
                abandon(attempt),
                Effect.forEach(Option.toArray(attempt.storage), closeStorage, {
                  discard: true,
                })
              ),
            { concurrency: "unbounded", discard: true }
          );
        })
      );

      const openTimeout = yield* BrainOpenTimeout;

      // One reopen's open, on its own fiber, so giving up on it never drops what it opens: it runs
      // to its end, then waits for its waiter to take what it made, or closes it if nobody waits.
      const startOpen = Effect.gen(function* () {
        const attempt = newOpening();

        opening.add(attempt);

        const fiber = yield* openParts(attempt).pipe(
          Effect.onExit(
            Exit.match({
              onFailure: () =>
                Effect.sync(() => {
                  opening.delete(attempt);
                }),
              onSuccess: (opened) =>
                Effect.suspend(() => {
                  if (attempt.abandoned) {
                    return closeLanded(attempt, opened);
                  }

                  attempt.landed = Option.some(opened);

                  return Effect.void;
                }),
            })
          ),
          Effect.forkDetach({ startImmediately: true })
        );

        return { attempt, fiber };
      });

      // One reopen attempt: a Session it opens is published before the supervisor can stop, so the
      // close finalizer closes it. It schedules work only once boot resumed (its repairs ran);
      // before that, boot's `resume` resumes it. The wait ends at `openTimeout`, or when the brain
      // closes; the open is then given up (`abandon`), so an open that hangs holds neither.
      const reopen = Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const { attempt, fiber } = yield* startOpen;

          const opened = yield* restore(
            Fiber.join(fiber).pipe(Effect.timeout(openTimeout))
          ).pipe(Effect.onError(() => abandon(attempt)));

          opening.delete(attempt);

          const next = yield* land(opened);

          yield* SubscriptionRef.set(current, Option.some(next));

          if (yield* Ref.get(resumed)) {
            next.harness.resume();
          }

          return next;
        })
      );

      // Reopens after the Session fails; ends after a clean close.
      const supervise = (session: BrainSession): Effect.Effect<void> =>
        Effect.gen(function* () {
          const end = yield* Effect.promise(
            async () => await session.harness.closed
          );

          if (end.kind === "closed") {
            return yield* Effect.void;
          }

          yield* Ref.set(down, "reopening");
          yield* SubscriptionRef.set(current, Option.none());
          yield* Effect.logError("brain session failed; reopening").pipe(
            Effect.annotateLogs({ error: errorText(end.error) })
          );

          const next = yield* reopen.pipe(
            Effect.tapError((error) =>
              Effect.logError("brain reopen failed").pipe(
                Effect.annotateLogs({ error: error.message })
              )
            ),
            Effect.retry(reopenSchedule),
            Effect.orDie
          );

          return yield* supervise(next);
        });

      yield* supervise(first).pipe(Effect.forkScoped);

      const session = Effect.gen(function* () {
        const open = yield* SubscriptionRef.get(current);

        if (Option.isSome(open)) {
          return open.value;
        }

        const state = yield* Ref.get(down);

        return yield* new BrainUnavailable({
          message: `The brain is ${state}. Try again in a moment.`,
          state,
        });
      });

      const subscribeCommits = (listener: CommitListener) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            listeners.add(listener);

            if (latest !== undefined) {
              attach(latest, listener);
            }
          }),
          () =>
            Effect.sync(() => {
              listeners.delete(listener);
              detach.get(listener)?.();
              detach.delete(listener);
            })
        );

      return Brain.of({
        session,
        subscribeCommits,
        sessions: SubscriptionRef.changes(current).pipe(
          Stream.filter(Option.isSome),
          Stream.map((open) => open.value),
          Stream.changesWith((a, b) => a.generation === b.generation)
        ),
        resume: Effect.gen(function* () {
          yield* Ref.set(resumed, true);

          const open = yield* SubscriptionRef.get(current);
          const state = yield* Ref.get(down);

          // A Session the supervisor is reopening resumes as it opens; a closing brain does not.
          if (Option.isNone(open) && state === "closing") {
            return yield* new BrainUnavailable({
              message: `The brain is ${state}. Try again in a moment.`,
              state,
            });
          }

          if (Option.isSome(open)) {
            open.value.harness.resume();
          }

          return yield* Effect.void;
        }),
        now,
      });
    })
  );
}
