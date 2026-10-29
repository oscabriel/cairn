// The pi-durable seam's subagent additions, over a real Harness: the commit feed names a child's
// parent on its ThreadEnsured (from `cairn.child`, written in the creating commit) and turns each
// status change in a parent's `cairn.subagents` into one SubagentUpdated, and a note written with
// `model` content reaches the next model request while a display-only write does not. The
// documents are committed here by hand, as the subagents extension will commit them. A note left
// queued by a stopped or failed run is placed when that run ends, ahead of any later note.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { CHILD_DOCUMENT, SUBAGENTS_DOCUMENT } from "@cairn/protocol/Subagents";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { defineDoc, InboxDoc } from "@earendil-works/pi-durable";
import type { Tx } from "@earendil-works/pi-durable";
import { assert, describe, it } from "@effect/vitest";
import {
  Context,
  Deferred,
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
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { ThreadMeta } from "./CairnDocs.ts";
import { messageText } from "./CommitFeed.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";
import { piConversationId } from "./PiIds.ts";

const PARENT = ThreadId.make("0190f0c0-0000-7000-8000-0000000000d1");

const CHILD = ThreadId.make("0190f0c0-0000-7000-8000-0000000000d2");

const PROJECT = ProjectId.make("commit-feed-test");

/** `cairn.child` as the subagents extension writes it; only the parent matters here. */
interface ChildState {
  [key: string]: JsonValue;
  parentThreadId: string;
}

const ChildDoc = defineDoc<ChildState>({
  kind: CHILD_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ parentThreadId: "" }),
  checkpointWhen: () => false,
});

/** `cairn.subagents` as the subagents extension writes it; the feed reads id and status. */
interface SubagentsState {
  [key: string]: JsonValue;
  items: { [key: string]: JsonValue };
}

const SubagentsDoc = defineDoc<SubagentsState>({
  kind: SUBAGENTS_DOCUMENT,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ items: {} }),
  checkpointWhen: () => false,
});

const harnessLayer = (dataDir: string) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.layer.pipe(
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ModelHealth.layerTest),
        Layer.provide(SettingsStore.layerTest),
        Layer.provide(ReachServicesTest),
        Layer.provide(Subagents.layerTest),
        Layer.provide(PiModelSource.layerFromModelSource)
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
const waitFor = <A>(find: Effect.Effect<Option.Option<A>>) =>
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

interface Fixture {
  readonly seam: HarnessSeam["Service"];
  readonly brain: Brain["Service"];
  readonly faux: FauxModels["Service"]["faux"];
  readonly events: Ref.Ref<ReadonlyArray<HarnessEvent>>;
  readonly parentConversation: ReturnType<typeof piConversationId>;
}

/** Runs `body` over a fresh brain with the parent thread ensured. */
const withBrain = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-commit-feed-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(harnessLayer(dataDir));
          const seam = Context.get(context, HarnessSeam);
          const brain = Context.get(context, Brain);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );
          yield* brain.resume;

          const { conversationId } = yield* seam.ensureThread({
            threadId: PARENT,
            projectId: PROJECT,
            model: FAUX_MODEL,
            thinkingLevel: "off",
            cwd: process.cwd(),
            instructions: Option.none(),
            runtimeMode: "full-access",
          });

          return yield* body({
            seam,
            brain,
            faux,
            events,
            parentConversation: piConversationId(conversationId),
          });
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

/** One host commit, as the subagents extension's tasks make them. */
const commit = (brain: Brain["Service"], change: (tx: Tx) => Promise<void>) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(brain.session);

    yield* Effect.promise(async () => {
      await harness.commit(change, BACKGROUND_CONTEXT);
    });
  });

/** The `data.seq` of every subagent result note in the parent's transcript, in entry order. */
const noteSeqs = (
  brain: Brain["Service"],
  conversationId: Fixture["parentConversation"]
) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(brain.session);

    return yield* Effect.promise(
      async () =>
        await harness.commit(async (tx) => {
          const page = await tx.scanEntries(
            { conversationId, order: "ascending" },
            100
          );

          return page.items.flatMap((entry) =>
            entry.kind === "cairn.subagent-result" &&
            Predicate.isObject(entry.data) &&
            "seq" in entry.data
              ? [entry.data.seq]
              : []
          );
        }, BACKGROUND_CONTEXT)
    );
  });

/** The number of inputs queued in the parent's `pi.inbox`. */
const queuedInputCount = (
  brain: Brain["Service"],
  conversationId: Fixture["parentConversation"]
) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.orDie(brain.session);

    const inbox = yield* Effect.promise(
      async () =>
        await harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT)
    );

    return (inbox?.items ?? []).filter((item) => item.mode !== "write").length;
  });

/** A subagent result note with sequence number `seq`. */
const resultNote = (seq: number) => ({
  requestId: `subagent-note-x-${seq}`,
  kind: "cairn.subagent-result",
  data: { seq },
  model: [{ type: "text" as const, text: `NOTE ${seq}` }],
});

/** Waits until `count` reaches `least`. */
const atLeast = (count: Effect.Effect<number>, least: number) =>
  waitFor(
    Effect.map(count, (found) =>
      found >= least ? Option.some(true) : Option.none()
    )
  );

/** A text input that queues behind a run. */
const input = (requestId: string, text: string) => ({
  requestId,
  content: [{ type: "text" as const, text }],
  entry: Option.none(),
  whenBusy: "followUp" as const,
});

const subagentEvents = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((event) =>
    Predicate.isTagged(event, "SubagentUpdated") ? [event] : []
  );

describe("CommitFeed subagent events", () => {
  it.live(
    "a child's creating commit names its parent, and each registry status change is one SubagentUpdated",
    () =>
      withBrain(({ brain, events, parentConversation }) =>
        Effect.gen(function* () {
          yield* commit(brain, async (tx) => {
            const child = await tx.createConversation({
              ownership: { kind: "ownerless" },
            });

            const meta = await tx.doc(ThreadMeta, child.id);

            meta.threadId = CHILD;
            meta.projectId = PROJECT;

            const link = await tx.doc(ChildDoc, child.id);

            link.parentThreadId = PARENT;
          });

          const ensured = yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              Option.fromUndefinedOr(
                all.find(
                  (event) =>
                    Predicate.isTagged(event, "ThreadEnsured") &&
                    event.threadId === CHILD
                )
              )
            )
          );

          assert.deepStrictEqual(
            Predicate.isTagged(ensured, "ThreadEnsured")
              ? ensured.parent
              : Option.none(),
            Option.some(PARENT)
          );

          const setItem = (status: string, delivered: number) =>
            commit(brain, async (tx) => {
              const registry = await tx.doc(SubagentsDoc, parentConversation);

              registry.items["brief-1"] = {
                threadId: CHILD,
                status,
                delivered,
              };
            });

          yield* setItem("working", 0);
          yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              subagentEvents(all).length >= 1
                ? Option.some(true)
                : Option.none()
            )
          );

          // Another field changed, the status did not: no event.
          yield* setItem("working", 1);
          yield* setItem("settled", 1);
          yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              subagentEvents(all).length >= 2
                ? Option.some(true)
                : Option.none()
            )
          );
          yield* Effect.sleep(Duration.millis(200));

          const updates = subagentEvents(yield* Ref.get(events)).map(
            (event) => [event.threadId, event.child, event.status]
          );

          assert.deepStrictEqual(updates, [
            [PARENT, CHILD, "working"],
            [PARENT, CHILD, "settled"],
          ]);
        })
      ),
    30_000
  );

  it.live(
    "a note's model content reaches the next request, once per request id, and a display entry does not",
    () =>
      withBrain(({ seam, faux, events }) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<ReadonlyArray<string>>([]);
          const run = Effect.runPromiseWith(yield* Effect.context());

          faux.setResponses([
            async (request) =>
              await run(
                Effect.as(
                  Ref.set(
                    seen,
                    request.messages.flatMap((message: Message) =>
                      message.role === "user" ? [messageText(message)] : []
                    )
                  ),
                  fauxAssistantMessage("read it")
                )
              ),
          ]);

          const note = {
            requestId: "subagent-note-x-1",
            kind: "cairn.subagent-result",
            data: { seq: 1 },
            model: [{ type: "text" as const, text: "NOTE child done" }],
          };

          yield* seam.write(PARENT, note);
          yield* seam.write(PARENT, note);
          yield* seam.write(PARENT, {
            requestId: "display-1",
            kind: "cairn.checkpoint",
            data: { turn: 1 },
          });
          yield* seam.submit(PARENT, {
            requestId: "wake-1",
            content: [{ type: "text", text: "wake" }],
            entry: Option.none(),
            whenBusy: "followUp",
          });

          yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              all.some(
                (event) =>
                  Predicate.isTagged(event, "RunTerminal") &&
                  event.threadId === PARENT
              )
                ? Option.some(true)
                : Option.none()
            )
          );

          assert.deepStrictEqual(yield* Ref.get(seen), [
            "NOTE child done",
            "wake",
          ]);
        })
      ),
    30_000
  );

  it.live(
    "a note on a stopped thread with a queued follow-up is placed, places nothing queued and starts no run",
    () =>
      withBrain(({ seam, faux, events }) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<ReadonlyArray<string>>([]);
          const run = Effect.runPromiseWith(yield* Effect.context());

          // The first request hangs until the stop aborts it; the next records what it read.
          faux.setResponses([
            async (_request, options) =>
              await run(
                Effect.as(
                  Effect.callback<boolean>((resume) => {
                    options?.signal?.addEventListener(
                      "abort",
                      () => {
                        resume(Effect.succeed(true));
                      },
                      { once: true }
                    );
                  }),
                  fauxAssistantMessage("stopped")
                )
              ),
            async (request) =>
              await run(
                Effect.as(
                  Ref.set(
                    seen,
                    request.messages.flatMap((message: Message) =>
                      message.role === "user" ? [messageText(message)] : []
                    )
                  ),
                  fauxAssistantMessage("read it")
                )
              ),
          ]);

          const runs = Effect.map(
            Ref.get(events),
            (all) =>
              all.filter(
                (event) =>
                  Predicate.isTagged(event, "RunStarted") &&
                  event.threadId === PARENT
              ).length
          );

          const terminals = Effect.map(
            Ref.get(events),
            (all) =>
              all.filter(
                (event) =>
                  Predicate.isTagged(event, "RunTerminal") &&
                  event.threadId === PARENT
              ).length
          );

          yield* seam.submit(PARENT, input("r1", "one"));
          yield* atLeast(runs, 1);
          yield* seam.submit(PARENT, input("r2", "two"));
          yield* seam.stop(PARENT, { clearQueue: false, subagents: "keep" });
          yield* atLeast(terminals, 1);

          const note = {
            requestId: "subagent-note-x-1",
            kind: "cairn.subagent-result",
            data: { seq: 1 },
            model: [{ type: "text" as const, text: "NOTE child done" }],
          };

          yield* seam.write(PARENT, note);
          yield* seam.write(PARENT, note);
          yield* Effect.sleep(Duration.millis(300));

          assert.strictEqual(yield* runs, 1);

          // The user's next message places the queued follow-up; the note is already there.
          yield* seam.submit(PARENT, input("r3", "three"));
          yield* atLeast(terminals, 2);

          const read = yield* Ref.get(seen);

          assert.deepStrictEqual(
            read.filter((text) => text === "NOTE child done"),
            ["NOTE child done"]
          );
          assert.isTrue(read.includes("two"));
          assert.isBelow(read.indexOf("NOTE child done"), read.indexOf("two"));
        })
      ),
    30_000
  );

  it.live(
    "a note written during a run waits for the next boundary and lands ahead of a queued follow-up",
    () =>
      withBrain(({ seam, faux, events }) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<ReadonlyArray<string>>([]);
          const release = yield* Deferred.make<boolean>();
          const run = Effect.runPromiseWith(yield* Effect.context());

          faux.setResponses([
            async () =>
              await run(
                Effect.as(
                  Deferred.await(release),
                  fauxAssistantMessage("one done")
                )
              ),
            async (request) =>
              await run(
                Effect.as(
                  Ref.set(
                    seen,
                    request.messages.flatMap((message: Message) =>
                      message.role === "user" ? [messageText(message)] : []
                    )
                  ),
                  fauxAssistantMessage("read it")
                )
              ),
          ]);

          yield* seam.submit(PARENT, input("r1", "one"));
          yield* seam.submit(PARENT, input("r2", "two"));
          yield* seam.write(PARENT, {
            requestId: "subagent-note-x-1",
            kind: "cairn.subagent-result",
            data: { seq: 1 },
            model: [{ type: "text" as const, text: "NOTE child done" }],
          });
          yield* Deferred.succeed(release, true);

          yield* waitFor(
            Effect.map(Ref.get(events), (all) =>
              all.some(
                (event) =>
                  Predicate.isTagged(event, "RunTerminal") &&
                  event.threadId === PARENT
              )
                ? Option.some(true)
                : Option.none()
            )
          );

          assert.deepStrictEqual(yield* Ref.get(seen), [
            "one",
            "NOTE child done",
            "two",
          ]);
        })
      ),
    30_000
  );
  it.live(
    "a note queued during a run that is stopped is placed by the stop, ahead of a later note, its follow-up still queued",
    () =>
      withBrain(({ seam, brain, faux, events, parentConversation }) =>
        Effect.gen(function* () {
          const run = Effect.runPromiseWith(yield* Effect.context());

          // The only request hangs until the stop aborts it.
          faux.setResponses([
            async (_request, options) =>
              await run(
                Effect.as(
                  Effect.callback<boolean>((resume) => {
                    options?.signal?.addEventListener(
                      "abort",
                      () => {
                        resume(Effect.succeed(true));
                      },
                      { once: true }
                    );
                  }),
                  fauxAssistantMessage("stopped")
                )
              ),
          ]);

          const count = (tag: "RunStarted" | "RunTerminal") =>
            Effect.map(
              Ref.get(events),
              (all) =>
                all.filter(
                  (event) =>
                    Predicate.isTagged(event, tag) && event.threadId === PARENT
                ).length
            );

          yield* seam.submit(PARENT, input("r1", "one"));
          yield* atLeast(count("RunStarted"), 1);
          yield* seam.submit(PARENT, input("r2", "two"));
          yield* seam.write(PARENT, resultNote(1));

          assert.deepStrictEqual(
            yield* noteSeqs(brain, parentConversation),
            []
          );

          yield* seam.stop(PARENT, { clearQueue: false, subagents: "keep" });
          yield* atLeast(count("RunTerminal"), 1);

          assert.deepStrictEqual(
            yield* noteSeqs(brain, parentConversation),
            [1]
          );

          yield* seam.write(PARENT, resultNote(2));
          yield* Effect.sleep(Duration.millis(300));

          assert.deepStrictEqual(
            yield* noteSeqs(brain, parentConversation),
            [1, 2]
          );
          assert.strictEqual(
            yield* queuedInputCount(brain, parentConversation),
            1
          );
          assert.strictEqual(yield* count("RunStarted"), 1);
        })
      ),
    30_000
  );
  it.live(
    "a note queued during a run that fails is placed once the run ends, its follow-up still queued",
    () =>
      withBrain(({ seam, brain, faux, events, parentConversation }) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<boolean>();
          const run = Effect.runPromiseWith(yield* Effect.context());

          faux.setResponses([
            async () =>
              await run(
                Effect.as(
                  Deferred.await(release),
                  fauxAssistantMessage("", {
                    stopReason: "error",
                    errorMessage: "400 bad request",
                  })
                )
              ),
          ]);

          const failed = Effect.map(
            Ref.get(events),
            (all) =>
              all.filter(
                (event) =>
                  Predicate.isTagged(event, "RunTerminal") &&
                  event.threadId === PARENT &&
                  event.status === "failed"
              ).length
          );

          yield* seam.submit(PARENT, input("r1", "one"));
          yield* seam.submit(PARENT, input("r2", "two"));
          yield* seam.write(PARENT, resultNote(1));
          yield* Deferred.succeed(release, true);
          yield* atLeast(failed, 1);

          yield* waitFor(
            Effect.map(noteSeqs(brain, parentConversation), (seqs) =>
              seqs.length > 0 ? Option.some(seqs) : Option.none()
            )
          );

          assert.deepStrictEqual(
            yield* noteSeqs(brain, parentConversation),
            [1]
          );
          assert.strictEqual(
            yield* queuedInputCount(brain, parentConversation),
            1
          );
        })
      ),
    30_000
  );
});
