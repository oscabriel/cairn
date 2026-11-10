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
// - Close: on scope close, the supervisor stops first, so a reopen it was making either published
//   its Session or opened nothing (an open that hangs gives up at `BrainOpenTimeout`); then
//   `harness.close` with a 5 s timeout. A task that ignores its
//   signal keeps close pending; past the timeout the process exits anyway and the task counts one
//   restart.
//
// Open and close follow cairn-v1, apps/server/src/Harnesses.ts at 1a5cd4a; the boot order comes
// from spikes/3-workflows/brain.ts and spikes/4-approvals/brain.ts in this repo.

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
import type { Scope } from "effect";

import { Arms } from "./Arms.ts";
import { BrainOpenTimeout } from "./BrainOpenTimeout.ts";
import { BrainStore } from "./BrainStore.ts";
import { durable, errorText } from "./Durable.ts";
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

      const openSession = Effect.gen(function* () {
        const storage = yield* store.open;

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
              context
            )
        );

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

      const first = yield* openSession.pipe(Effect.orDie);

      yield* SubscriptionRef.set(current, Option.some(first));

      // Added before the supervisor is forked, so on close the supervisor stops first: a reopen
      // attempt in flight finishes and publishes, and this closes whatever Session is open.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Ref.set(down, "closing");

          const open = yield* SubscriptionRef.getAndSet(current, Option.none());

          if (Option.isSome(open)) {
            yield* durable("close", async (context) => {
              await open.value.harness.close(context);
            }).pipe(
              Effect.timeout(CLOSE_TIMEOUT),
              Effect.catch((error) =>
                Effect.logWarning("brain close did not finish").pipe(
                  Effect.annotateLogs({ error: errorText(error) })
                )
              )
            );
          }
        })
      );

      const openTimeout = yield* BrainOpenTimeout;

      // One reopen attempt, whole or not at all: a Session it opens is published before the
      // supervisor can stop, so the close finalizer closes it. It schedules work only once boot
      // resumed (its repairs ran); before that, boot's `resume` resumes it. An open that hangs
      // fails the attempt at `openTimeout`, so it cannot hold a shutdown for good: the timeout
      // cancels the open's context, and pi-durable closes what a failed open opened.
      const reopen = Effect.uninterruptible(
        Effect.gen(function* () {
          const next = yield* openSession.pipe(Effect.timeout(openTimeout));

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
