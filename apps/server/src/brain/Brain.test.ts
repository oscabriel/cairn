// The brain's supervisor across a storage failure: a reopened Session is resumed with the commit
// feed already attached, so the run the failure cut off still reaches `RunTerminal`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Function,
  Fiber,
  Latch,
  Layer,
  Option,
  Predicate,
  Ref,
  Scope,
  Stream,
} from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { BrainOpenTimeout } from "./BrainOpenTimeout.ts";
import { BrainStore } from "./BrainStore.ts";
import { CommitFeed } from "./CommitFeed.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const isRunTerminal = (
  event: HarnessEvent
): event is Extract<HarnessEvent, { readonly _tag: "RunTerminal" }> =>
  Predicate.isTagged(event, "RunTerminal");

const THREAD_ID = ThreadId.make("0190f0c0-0000-7000-8000-0000000000b1");

/** Storage whose next `commit` rejects once `failNext` is set, as a platform reset would. */
const failing = (storage: Storage, failNext: { value: boolean }): Storage => {
  const commit = storage.commit.bind(storage);

  storage.commit = async (batches, receive, context) => {
    if (failNext.value) {
      failNext.value = false;

      throw new Error("storage reset (test)");
    }

    return await commit(batches, receive, context);
  };

  return storage;
};

/** Storage whose task scans never answer, so a Harness opened over it never finishes opening. */
const hanging = (storage: Storage, reached: () => void): Storage => {
  storage.scanTasks = async () => {
    reached();

    return await Promise.withResolvers<never>().promise;
  };

  return storage;
};

/** The production seam and brain over a temporary store whose commits the test can fail. */
const brainLayer = (dataDir: string, failNext: { value: boolean }) => {
  const store = Layer.effect(
    BrainStore,
    Effect.map(BrainStore, (real) =>
      BrainStore.of({
        ...real,
        open: Effect.map(real.open, (storage) => failing(storage, failNext)),
      })
    )
  ).pipe(Layer.provide(BrainStore.layer));

  return PiDurableHarness.layerNoDeps.pipe(
    Layer.provide(CommitFeed.layerNoDeps),
    Layer.provideMerge(
      Brain.layerNoDeps.pipe(Layer.provide(store), Layer.provide(Arms.layer))
    ),
    Layer.provide(ExtensionSet.layer),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(PiHost.layerEmpty),
    Layer.provide(ModelHealth.layerTest),
    Layer.provide(SettingsStore.layerTest),
    Layer.provide(ReachServicesTest),
    Layer.provide(Subagents.layerTest),
    Layer.provide(PiModelSource.layerFromModelSource),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        // pi-durable 1.5 charges a request the failure cut off as a failed attempt instead of
        // resending it, so the reopened Session answers through one quick retry.
        settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
      })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );
};

const withBrain = <A, E>(
  use: (
    context: Context.Context<HarnessSeam | Brain | FauxModels>,
    failNext: { value: boolean }
  ) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-brain-test-"))),
    (dataDir) => {
      const failNext = { value: false };

      return Effect.scoped(
        Effect.flatMap(Layer.build(brainLayer(dataDir, failNext)), (context) =>
          use(context, failNext)
        )
      ).pipe(Effect.orDie);
    },
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A>(find: Effect.Effect<Option.Option<A>>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* find;

      if (Option.isSome(found)) {
        return found;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return Option.none<A>();
  });

describe("Brain supervisor", () => {
  it.live(
    "a reopened Session's resumed run still reaches RunTerminal",
    () =>
      withBrain((context, failNext) =>
        Effect.gen(function* () {
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const { faux } = Context.get(context, FauxModels);

          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);
          const generations = yield* Ref.make<ReadonlyArray<number>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );
          // Commits per Session generation, through the brain's own listener API.
          const heard = new Map<number, number>();

          yield* brain.subscribeCommits((session) => {
            heard.set(
              session.generation,
              (heard.get(session.generation) ?? 0) + 1
            );
          });
          yield* brain.sessions.pipe(
            Stream.runForEach((session: BrainSession) =>
              Ref.update(generations, (all) => [...all, session.generation])
            ),
            Effect.forkScoped
          );

          // The first answer arms the failure, so the commit that would record it fails the
          // Session; the reopened Session retries the cut-off request and gets the second answer.
          faux.setResponses([
            async () => {
              failNext.value = true;

              return await Promise.resolve(fauxAssistantMessage("lost"));
            },
            async () =>
              await Promise.resolve(fauxAssistantMessage("after reopen")),
          ]);

          yield* Effect.sleep(Duration.millis(30));
          yield* brain.resume;

          yield* seam.ensureThread({
            threadId: THREAD_ID,
            projectId: ProjectId.make("brain-test"),
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: process.cwd(),
            instructions: Option.none(),
            runtimeMode: "full-access",
          });
          yield* seam.submit(THREAD_ID, {
            requestId: "reopen-1",
            content: [{ type: "text", text: "hello" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          const terminal = yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              Option.fromUndefinedOr(all.find((event) => isRunTerminal(event)))
            )
          );

          assert.deepStrictEqual(yield* Ref.get(generations), [1, 2]);
          assert.isAbove(
            heard.get(1) ?? 0,
            0,
            "no commit of the first Session"
          );
          assert.isAbove(
            heard.get(2) ?? 0,
            0,
            "no commit of the reopened Session"
          );
          assert.deepStrictEqual(
            Option.map(terminal, (event) => event.status),
            Option.some("completed"),
            "the resumed run's end was never seen"
          );
        })
      ),
    30_000
  );

  it.live(
    "a Session that fails before boot resumed reopens without scheduling work",
    () =>
      withBrain((context, failNext) =>
        Effect.gen(function* () {
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const { faux } = Context.get(context, FauxModels);
          const generations = yield* Ref.make<ReadonlyArray<number>>([]);

          yield* brain.sessions.pipe(
            Stream.runForEach((session: BrainSession) =>
              Ref.update(generations, (all) => [...all, session.generation])
            ),
            Effect.forkScoped
          );
          const called = yield* Ref.make(false);
          const run = Effect.runPromiseWith(yield* Effect.context());

          // The model is called only once the scheduler runs the queued input.
          faux.setResponses([
            async () => {
              await run(Ref.set(called, true));

              return fauxAssistantMessage("ran");
            },
          ]);

          // Boot has not resumed: an input queues, then a boot repair's commit fails the Session.
          yield* seam.ensureThread({
            threadId: THREAD_ID,
            projectId: ProjectId.make("brain-test"),
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: process.cwd(),
            instructions: Option.none(),
            runtimeMode: "full-access",
          });
          yield* seam.submit(THREAD_ID, {
            requestId: "before-resume",
            content: [{ type: "text", text: "hello" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          failNext.value = true;
          yield* Effect.ignore(
            seam.submit(THREAD_ID, {
              requestId: "repair-commit",
              content: [{ type: "text", text: "fails" }],
              entry: Option.none(),
              whenBusy: "followUp",
            })
          );
          yield* waitFor(
            Effect.map(Ref.get(generations), (all) =>
              all.includes(2) ? Option.some(true) : Option.none()
            )
          );
          yield* Effect.sleep(Duration.millis(500));

          assert.isFalse(
            yield* Ref.get(called),
            "the reopened Session ran work before boot resumed"
          );

          // Boot's resume, after its repairs, lets the reopened Session run.
          yield* brain.resume;

          const ran = yield* waitFor(
            Effect.map(Ref.get(called), (found) =>
              found ? Option.some(true) : Option.none()
            )
          );

          assert.isTrue(Option.isSome(ran));
        })
      ),
    30_000
  );

  it.live(
    "a reopen that lands while the brain closes is closed, not published",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "cairn-brain-test-"))
        ),
        (dataDir) =>
          Effect.gen(function* () {
            const failNext = { value: false };
            const opens = yield* Ref.make(0);
            const reopening = yield* Latch.make(false);
            const release = yield* Latch.make(false);
            const reopened = yield* Deferred.make<Storage>();

            // The second open (the supervisor's reopen) waits until the brain has begun closing.
            const gated = Layer.effect(
              BrainStore,
              Effect.map(BrainStore, (real) =>
                BrainStore.of({
                  ...real,
                  // A slow open the close cannot cut short.
                  open: Effect.uninterruptible(
                    Effect.gen(function* () {
                      const count = yield* Ref.updateAndGet(
                        opens,
                        (n) => n + 1
                      );

                      if (count === 2) {
                        yield* reopening.open;
                        yield* release.await;
                      }

                      const storage = failing(yield* real.open, failNext);

                      if (count === 2) {
                        yield* Deferred.succeed(reopened, storage);
                      }

                      return storage;
                    })
                  ),
                })
              )
            ).pipe(Layer.provide(BrainStore.layer));

            const layer = Brain.layerNoDeps.pipe(
              Layer.provide(gated),
              Layer.provide(Arms.layer),
              Layer.provide(ExtensionSet.layer),
              Layer.provide(ExecutorLink.layerDisabled),
              Layer.provide(PiHost.layerEmpty),
              Layer.provide(ModelHealth.layerTest),
              Layer.provide(SettingsStore.layerTest),
              Layer.provide(ReachServicesTest),
              Layer.provide(Subagents.layerTest),
              Layer.provide(PiModelSource.layerFromModelSource),
              Layer.provideMerge(
                ModelSource.layerFaux({
                  tokensPerSecond: 2000,
                  settings: { retry: { enabled: false } },
                })
              ),
              Layer.provide(BrainConfig.layerFrom(dataDir))
            );

            const scope = yield* Scope.make();
            const context = yield* Layer.buildWithScope(layer, scope);
            const brain = Context.get(context, Brain);
            const { harness } = yield* brain.session;

            // A storage failure: the Session fails, and the supervisor starts its reopen.
            failNext.value = true;
            yield* Effect.promise(
              async () =>
                await harness
                  .commit(async (tx) => {
                    await tx.createConversation({
                      ownership: { kind: "ownerless" },
                    });
                  }, BACKGROUND_CONTEXT)
                  .then(
                    () => "committed",
                    () => "failed"
                  )
            );
            yield* reopening.await;

            // Shutdown begins while the reopen is still opening; then the reopen completes.
            const closing = yield* Scope.close(scope, Exit.void).pipe(
              Effect.forkChild
            );

            yield* Effect.sleep(Duration.millis(100));
            yield* release.open;
            yield* Fiber.join(closing);

            const storage = yield* Deferred.await(reopened).pipe(
              Effect.timeoutOption(Duration.seconds(2))
            );

            const unavailable = yield* Effect.flip(brain.session);

            assert.strictEqual(unavailable.state, "closing");

            // Whatever the reopen opened was closed with the brain: its storage takes no commit.
            if (Option.isSome(storage)) {
              const after = yield* Effect.promise(
                async () =>
                  await storage.value
                    .commit([], Function.constVoid, BACKGROUND_CONTEXT)
                    .then(
                      () => "open",
                      () => "closed"
                    )
              );

              assert.strictEqual(after, "closed");
            }
          }),
        (dataDir) =>
          Effect.sync(() => {
            rmSync(dataDir, { recursive: true, force: true });
          })
      ),
    30_000
  );

  it.live(
    "a reopen whose open hangs gives up, so the brain still closes",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          mkdtempSync(path.join(tmpdir(), "cairn-brain-test-"))
        ),
        (dataDir) =>
          Effect.gen(function* () {
            const failNext = { value: false };
            const opens = yield* Ref.make(0);
            const hung = yield* Latch.make(false);
            const run = Effect.runPromiseWith(yield* Effect.context());

            // The second open (the supervisor's reopen) never finishes opening its Harness.
            const store = Layer.effect(
              BrainStore,
              Effect.map(BrainStore, (real) =>
                BrainStore.of({
                  ...real,
                  open: Effect.gen(function* () {
                    const count = yield* Ref.updateAndGet(opens, (n) => n + 1);
                    const storage = failing(yield* real.open, failNext);

                    return count === 2
                      ? hanging(storage, () => {
                          void run(hung.open);
                        })
                      : storage;
                  }),
                })
              )
            ).pipe(Layer.provide(BrainStore.layer));

            const layer = Brain.layerNoDeps.pipe(
              Layer.provide(store),
              Layer.provide(Arms.layer),
              Layer.provide(ExtensionSet.layer),
              Layer.provide(ExecutorLink.layerDisabled),
              Layer.provide(PiHost.layerEmpty),
              Layer.provide(ModelHealth.layerTest),
              Layer.provide(SettingsStore.layerTest),
              Layer.provide(ReachServicesTest),
              Layer.provide(Subagents.layerTest),
              Layer.provide(PiModelSource.layerFromModelSource),
              Layer.provideMerge(
                ModelSource.layerFaux({
                  tokensPerSecond: 2000,
                  settings: { retry: { enabled: false } },
                })
              ),
              Layer.provide(BrainConfig.layerFrom(dataDir)),
              Layer.provide(
                Layer.succeed(BrainOpenTimeout, Duration.millis(300))
              )
            );

            const scope = yield* Scope.make();
            const context = yield* Layer.buildWithScope(layer, scope);
            const brain = Context.get(context, Brain);
            const { harness } = yield* brain.session;

            // A storage failure: the Session fails, and the supervisor's reopen hangs in its open.
            failNext.value = true;
            yield* Effect.promise(
              async () =>
                await harness
                  .commit(async (tx) => {
                    await tx.createConversation({
                      ownership: { kind: "ownerless" },
                    });
                  }, BACKGROUND_CONTEXT)
                  .then(
                    () => "committed",
                    () => "failed"
                  )
            );
            yield* hung.await;

            const closed = yield* Scope.close(scope, Exit.void).pipe(
              Effect.timeoutOption(Duration.seconds(5))
            );

            assert.isTrue(
              Option.isSome(closed),
              "the brain's close never ended"
            );
          }),
        (dataDir) =>
          Effect.sync(() => {
            rmSync(dataDir, { recursive: true, force: true });
          })
      ),
    30_000
  );
});
