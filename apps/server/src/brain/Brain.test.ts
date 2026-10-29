// The brain's supervisor across a storage failure: a reopened Session is resumed with the commit
// feed already attached, so the run the failure cut off still reaches `RunTerminal`; and
// `retry` keeps `task_not_found` for a task pi-durable does not have.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, TaskId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { Arms } from "./Arms.ts";
import { Brain } from "./Brain.ts";
import type { BrainSession } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { BrainStore } from "./BrainStore.ts";
import { CommitFeed } from "./CommitFeed.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { Parked } from "./Parked.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

const isRunTerminal = (
  event: HarnessEvent
): event is Extract<HarnessEvent, { readonly _tag: "RunTerminal" }> =>
  Predicate.isTagged(event, "RunTerminal");

const THREAD_ID = ThreadId.make("0190f0c0-0000-7000-8000-0000000000b1");

/** Storage whose next `commit` rejects once `failNext` is set, as a platform reset would. */
const failing = (storage: Storage, failNext: { value: boolean }): Storage => {
  const commit = storage.commit.bind(storage);

  storage.commit = async (writes, context) => {
    if (failNext.value) {
      failNext.value = false;

      throw new Error("storage reset (test)");
    }

    return await commit(writes, context);
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
    Layer.provideMerge(Parked.layer),
    Layer.provide(ExtensionSet.layer),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(PiHost.layerEmpty),
    Layer.provide(ModelHealth.layerTest),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
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
          // Session; the reopened Session runs the generation again and gets the second answer.
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

  it.live("retry of a task the brain does not have is task_not_found", () =>
    withBrain((context) =>
      Effect.gen(function* () {
        const seam = Context.get(context, HarnessSeam);
        const brain = Context.get(context, Brain);

        yield* brain.resume;

        const failure = yield* Effect.flip(seam.retry(TaskId.make(987_654)));

        assert.strictEqual(failure.reason, "task_not_found");
      })
    )
  );
});
