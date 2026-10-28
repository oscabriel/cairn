// The pi-durable seam's stop when `pi.live.run` moves between the stop's read and its abort. Each
// test holds the stop's first `abortTask` until the run moved on, so the stop aborts a task that is
// already terminal: a run handed over to the next generation (a tool round ended) must still end
// interrupted, and a run pi-durable started for a queued follow-up (the first one answered) must
// carry on; Cairn's events count that one as the same run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Latch,
  Layer,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect";
import type { Scope } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { conformanceTools } from "./conformance/ConformanceTools.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";
import { piConversationId } from "./PiIds.ts";

const THREAD_ID = ThreadId.make("0190f0c0-0000-7000-8000-0000000000c1");

/** How long a later generation's answer waits for an abort before it answers on its own. */
const CARRY_ON_AFTER = Duration.seconds(3);

type FauxMessage = ReturnType<typeof fauxAssistantMessage>;

type AbortContext = Parameters<Harness["abortTask"]>[1];

const harnessLayer = (dataDir: string) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.withExtra([conformanceTools]).pipe(
        Layer.provide(ExecutorLink.layerDisabled)
      )
    ),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A, E>(find: Effect.Effect<Option.Option<A>, E>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* find;

      if (Option.isSome(found)) {
        return found.value;
      }

      yield* Effect.sleep(Duration.millis(50));
    }

    return yield* Effect.die("waited ten seconds for nothing");
  });

/** Waits until at least `count` events tagged `tag` arrived for the thread; returns them all. */
const waitForEvents = <Tag extends HarnessEvent["_tag"]>(
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  tag: Tag,
  count: number
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) => {
      const found = all.filter(
        (event): event is Extract<HarnessEvent, { readonly _tag: Tag }> =>
          Predicate.isTagged(event, tag) && event.threadId === THREAD_ID
      );

      return Arr.isReadonlyArrayNonEmpty(found) && found.length >= count
        ? Option.some(found)
        : Option.none();
    })
  );

/** Answers `message` once `after` passed, or an aborted answer as soon as `signal` aborts. */
const answerUnlessAborted = (
  signal: AbortSignal | undefined,
  after: Duration.Duration,
  message: FauxMessage
) =>
  Effect.callback<FauxMessage>((resume) => {
    signal?.addEventListener(
      "abort",
      () => {
        resume(
          Effect.succeed(fauxAssistantMessage("", { stopReason: "aborted" }))
        );
      },
      { once: true }
    );
  }).pipe(
    Effect.timeoutOrElse({
      duration: after,
      orElse: () => Effect.succeed(message),
    })
  );

interface Fixture {
  readonly seam: HarnessSeam["Service"];
  readonly faux: FauxModels["Service"]["faux"];
  readonly events: Ref.Ref<ReadonlyArray<HarnessEvent>>;
  /** Runs an Effect from a faux response. */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /**
   * Holds the next `abortTask` until `pi.live.run` belongs to another task than the one asked to
   * be aborted, after `move` ran to make it so; the ref turns true when that abort was asked for.
   */
  readonly holdNextAbort: (
    move: Effect.Effect<void>
  ) => Effect.Effect<Ref.Ref<boolean>>;
}

/** Runs `body` over a fresh brain with one ensured thread and the conformance tools. */
const withHarness = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-harness-stop-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(harnessLayer(dataDir));
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const { faux } = Context.get(context, FauxModels);
          const run = Effect.runPromiseWith(yield* Effect.context());
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );
          yield* brain.resume;

          const { conversationId } = yield* seam.ensureThread({
            threadId: THREAD_ID,
            projectId: ProjectId.make("harness-stop-test"),
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: process.cwd(),
            instructions: Option.none(),
          });

          const holdNextAbort = Effect.fnUntraced(function* (
            move: Effect.Effect<void>
          ) {
            const { harness } = yield* Effect.orDie(brain.session);
            const abortTask = harness.abortTask.bind(harness);
            const held = yield* Ref.make(false);

            const movedFrom = (taskId: number, abortContext: AbortContext) =>
              Effect.promise(
                async () =>
                  await harness.snapshot(
                    LiveDoc,
                    piConversationId(conversationId),
                    abortContext
                  )
              ).pipe(
                Effect.map((live) =>
                  Option.filter(
                    Option.fromUndefinedOr(live?.run),
                    (next) => next.taskId !== taskId
                  )
                ),
                waitFor
              );

            harness.abortTask = async (taskId, abortContext) => {
              if (!(await run(Ref.getAndSet(held, true)))) {
                await run(
                  Effect.andThen(move, movedFrom(taskId, abortContext))
                );
              }

              return await abortTask(taskId, abortContext);
            };

            return held;
          });

          return yield* body({ seam, faux, events, run, holdNextAbort });
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

describe("PiDurableHarness stop", () => {
  it.live(
    "a stop whose run hands over to the next generation between its read and its abort still interrupts the run",
    () =>
      withHarness(({ seam, faux, events, run, holdNextAbort }) =>
        Effect.gen(function* () {
          // The first generation calls `gate`, which waits for an approval; the next one (after
          // the round hands over) answers only if nothing aborts it first.
          faux.setResponses([
            async () =>
              await Promise.resolve(
                fauxAssistantMessage([fauxToolCall("gate", {})], {
                  stopReason: "toolUse",
                })
              ),
            async (_request, options) =>
              await run(
                answerUnlessAborted(
                  options?.signal,
                  CARRY_ON_AFTER,
                  fauxAssistantMessage("carried on")
                )
              ),
          ]);

          yield* seam.submit(THREAD_ID, {
            requestId: "handover-1",
            content: [{ type: "text", text: "open the gate" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          const [asked] = yield* waitForEvents(
            events,
            "RuntimeRequestUpdated",
            1
          );

          // The stop has read the run's task; before its abort lands, the approval ends the tool
          // round and the run hands over to the next generation.
          const aborted = yield* holdNextAbort(
            seam
              .respond(THREAD_ID, asked.id, {
                decision: "accept",
                reason: Option.none(),
                answers: Option.none(),
              })
              .pipe(Effect.orDie)
          );

          yield* seam.stop(THREAD_ID, { clearQueue: false });

          const [terminal] = yield* waitForEvents(events, "RunTerminal", 1);

          assert.isTrue(
            yield* Ref.get(aborted),
            "the stop never aborted a task"
          );
          assert.strictEqual(terminal.status, "interrupted");
        })
      ),
    30_000
  );

  it.live(
    "a stop whose run answered and started a queued follow-up between its read and its abort leaves the follow-up running",
    () =>
      withHarness(({ seam, faux, events, run, holdNextAbort }) =>
        Effect.gen(function* () {
          const firstAnswer = yield* Latch.make(false);

          // The first run answers once released; the follow-up's run takes a second, so the stop
          // still finds it running when it looks again.
          faux.setResponses([
            async () =>
              await run(
                Effect.as(firstAnswer.await, fauxAssistantMessage("one done"))
              ),
            async (_request, options) =>
              await run(
                answerUnlessAborted(
                  options?.signal,
                  Duration.seconds(1),
                  fauxAssistantMessage("two done")
                )
              ),
          ]);

          yield* seam.submit(THREAD_ID, {
            requestId: "queued-1",
            content: [{ type: "text", text: "one" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });
          yield* waitForEvents(events, "RunStarted", 1);
          yield* seam.submit(THREAD_ID, {
            requestId: "queued-2",
            content: [{ type: "text", text: "two" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          // The stop has read the first run's task; before its abort lands, that run answers and
          // its final boundary starts a new run for the queued follow-up.
          const aborted = yield* holdNextAbort(firstAnswer.open);

          yield* seam.stop(THREAD_ID, { clearQueue: false });

          // The follow-up's run is the same run to Cairn: one RunTerminal, after its answer.
          const [terminal] = yield* waitForEvents(events, "RunTerminal", 1);

          const answers = (yield* waitForEvents(events, "MessageCommitted", 1))
            .filter((message) => message.role === "assistant")
            .map((message) => message.text);

          assert.isTrue(
            yield* Ref.get(aborted),
            "the stop never aborted a task"
          );
          assert.strictEqual(terminal.status, "completed");
          assert.deepStrictEqual(answers, ["one done", "two done"]);
        })
      ),
    30_000
  );
});
