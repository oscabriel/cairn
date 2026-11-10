// A subagent task whose phase throws ends visibly and recoverably (review finding O-3,
// `subagents/TaskFailures.ts`), over a real pi-durable brain with the production subagents
// extension and a throw planted at one of its windows (`BriefFaults`, `SubagentCrashes`):
//
// - a Go'd brief whose start throws starts nothing, and its parent is told why, as a refused
//   start is, where pi-durable alone would end the start `faulted` with the brief accepted and
//   nobody told;
// - a declined brief whose tell throws still reaches its parent, as a note;
// - a reporter that throws before its run settled settles the input `failed`, its note saying the
//   result was not read, and the child's row leaves `working`;
// - a reporter that throws after its run settled still writes the result's note and marks it
//   delivered: a throw can lose the wake, never the result.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApprovalId, ProjectId } from "@cairn/protocol/Ids";
import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { testThreadId } from "../shell/ShellTestKit.ts";
import { BriefFaults } from "../subagents/BriefFaults.ts";
import type { BriefFaultPoint } from "../subagents/BriefFaults.ts";
import { SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { BudgetBook } from "../usage/BudgetBook.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { conformanceTools } from "./conformance/ConformanceTools.ts";
import { childWorkspacesAt } from "./conformance/Targets.ts";
import { durable } from "./Durable.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { HarnessSeam } from "./HarnessSeam.ts";
import type { HarnessEvent } from "./HarnessSeam.ts";
import { FAUX_MODEL, ModelSource } from "./ModelSource.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";
import { piConversationId } from "./PiIds.ts";
import { SubagentCrashes } from "./SubagentFaults.ts";
import type { SubagentCrashPoint } from "./SubagentFaults.ts";
import { renderBriefAnswer } from "./SubagentText.ts";

const PARENT = testThreadId(1);

/** What a planted throw says, so a test can find it in what the parent read. */
const PLANTED = "planted: this phase broke";

/** Where a test plants its one throw: a brief window or a delivery crash point. */
type Planted =
  | { readonly brief: BriefFaultPoint }
  | { readonly crash: SubagentCrashPoint };

/** Hooks that throw once at `planted`, and nowhere else. */
const plantedThrow = (planted: Planted) => {
  let fired = false;

  const at = (point: string, wanted: string) => {
    if (!fired && point === wanted) {
      fired = true;

      throw new Error(PLANTED);
    }
  };

  return {
    brief: {
      at: (point: BriefFaultPoint) => {
        if ("brief" in planted) {
          at(point, planted.brief);
        }
      },
    },
    crashes: {
      at: (point: SubagentCrashPoint) => {
        if ("crash" in planted) {
          at(point, planted.crash);
        }
      },
    },
  };
};

/** The production subagents extension over a faux model, with `planted`'s throw. */
const brainLayer = (dataDir: string, planted: Planted) => {
  const hooks = plantedThrow(planted);

  return PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.withExtra([conformanceTools]).pipe(
        Layer.provide(Subagents.layer),
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ReachServicesTest),
        Layer.provide(PiModelSource.layerFromModelSource)
      )
    ),
    Layer.provideMerge(BudgetBook.layer),
    Layer.provideMerge(ModelHealth.layerTest),
    Layer.provideMerge(SettingsStore.layerTest),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir)),
    Layer.provide(Layer.succeed(BriefFaults, hooks.brief)),
    Layer.provide(Layer.succeed(SubagentCrashes, hooks.crashes))
  );
};

type Services = Layer.Success<ReturnType<typeof brainLayer>>;

/** Polls `find` until it finds something, for up to ten seconds. */
const waitFor = <A, E, R>(find: Effect.Effect<Option.Option<A>, E, R>) =>
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

interface Running {
  readonly events: Ref.Ref<ReadonlyArray<HarnessEvent>>;
  readonly parent: ConversationId;
}

const ensure = (threadId: ThreadId) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.ensureThread({
      threadId,
      projectId: ProjectId.make("failures"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd: process.cwd(),
      instructions: Option.none(),
      runtimeMode: "full-access",
    })
  );

/** Over a fresh brain with `planted`'s throw: the parent thread, resumed. */
const withBrain = <A, E>(
  planted: Planted,
  responses: ReadonlyArray<ReturnType<typeof fauxAssistantMessage>>,
  body: (running: Running) => Effect.Effect<A, E, Services>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-failures-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(brainLayer(dataDir, planted));
          const seam = Context.get(context, HarnessSeam);
          const { faux } = Context.get(context, FauxModels);
          const events = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

          yield* seam.events.pipe(
            Stream.runForEach((event) =>
              Ref.update(events, (all) => [...all, event])
            ),
            Effect.forkScoped
          );

          faux.setResponses([...responses]);
          yield* Context.get(context, Brain).resume;

          const ensured = yield* ensure(PARENT).pipe(
            Effect.provideContext(context)
          );

          return yield* body({
            events,
            parent: ensured.conversationId,
          }).pipe(Effect.provideContext(context));
        })
      ).pipe(Effect.orDie),
    (dataDir) =>
      Effect.sync(() => {
        rmSync(dataDir, { recursive: true, force: true });
      })
  );

const SPAWN = [
  fauxAssistantMessage(
    fauxToolCall(
      "subagent_spawn",
      { description: "Count the files", brief: "Count the files, please." },
      { id: "c1" }
    ),
    { stopReason: "toolUse" }
  ),
  fauxAssistantMessage("Waiting for Go."),
];

const ask = Effect.flatMap(HarnessSeam, (seam) =>
  seam.submit(PARENT, {
    requestId: "r1",
    content: [{ type: "text", text: "delegate it" }],
    entry: Option.none(),
    whenBusy: "followUp",
  })
);

/** The first pending brief of the parent, once there is one. */
const firstBrief = (events: Ref.Ref<ReadonlyArray<HarnessEvent>>) =>
  waitFor(
    Effect.map(Ref.get(events), (all) =>
      Option.firstSomeOf(
        all.map((event) =>
          Predicate.isTagged(event, "RuntimeRequestUpdated") &&
          event.threadId === PARENT &&
          event.kind === "brief" &&
          event.status === "pending"
            ? Option.some(event.id)
            : Option.none()
        )
      )
    )
  );

const answer = (approvalId: string, decision: "accept" | "decline") =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.respond(PARENT, ApprovalId.make(approvalId), {
      decision,
      reason: Option.none(),
      answers: Option.none(),
      launch: Option.none(),
    })
  );

const read = <A>(
  name: string,
  body: (
    harness: Effect.Success<Brain["Service"]["session"]>["harness"],
    context: Parameters<
      Effect.Success<Brain["Service"]["session"]>["harness"]["inspect"]
    >[0]
  ) => Promise<A>
) =>
  Effect.gen(function* () {
    const { harness } = yield* Effect.flatMap(Brain, (brain) => brain.session);

    return yield* durable(
      name,
      async (context) => await body(harness, context)
    );
  }).pipe(Effect.orDie);

/** Every entry of `conversation`, as one JSON text. */
const transcriptOf = (conversation: ConversationId) =>
  read("test.entries", async (harness, context) => {
    const page = await harness.commit(
      async (tx) =>
        await tx.scanEntries(
          {
            conversationId: piConversationId(conversation),
            order: "ascending",
          },
          200
        ),
      context
    );

    return JSON.stringify(page.items);
  });

/** Waits until the parent's transcript holds `text`. */
const transcriptHolds = (conversation: ConversationId, text: string) =>
  waitFor(
    Effect.map(transcriptOf(conversation), (transcript) =>
      transcript.includes(JSON.stringify(text).slice(1, -1))
        ? Option.some(transcript)
        : Option.none()
    )
  );

/** The parent's one registry item, once its first settlement is delivered. */
const deliveredItem = (parent: ConversationId) =>
  waitFor(
    Effect.map(
      read(
        "test.registry",
        async (harness, context) =>
          await harness.snapshot(
            SubagentsDoc,
            piConversationId(parent),
            context
          )
      ),
      (registry) =>
        Option.filter(
          Option.fromUndefinedOr(Object.values(registry?.items ?? {})[0]),
          (item) => item.delivered >= 1
        )
    )
  );

describe("a subagent task whose phase throws (O-3)", () => {
  it.live(
    "a Go'd brief whose start throws starts nothing, and the parent is told why",
    () =>
      withBrain(
        { brief: "start" },
        [...SPAWN, fauxAssistantMessage("Understood.")],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask;
            yield* answer(yield* firstBrief(events), "accept");

            yield* transcriptHolds(
              parent,
              renderBriefAnswer("Count the files", {
                kind: "startFailed",
                why: PLANTED,
              })
            );

            assert.isTrue(
              (yield* Ref.get(events)).every(
                (event) =>
                  !Predicate.isTagged(event, "ThreadEnsured") ||
                  Option.isNone(event.parent)
              )
            );
          })
      ),
    30_000
  );

  it.live(
    "a declined brief whose tell throws still reaches the parent, as a note",
    () =>
      withBrain({ brief: "tell" }, SPAWN, ({ events, parent }) =>
        Effect.gen(function* () {
          yield* ask;
          yield* answer(yield* firstBrief(events), "decline");

          const transcript = yield* transcriptHolds(
            parent,
            renderBriefAnswer("Count the files", {
              kind: "declined",
              reason: Option.none(),
            })
          );

          assert.include(transcript, '"started":false');
        })
      ),
    30_000
  );

  it.live(
    "a reporter that throws before its run settled settles the input failed, and the row leaves working",
    () =>
      withBrain(
        { crash: "reporter-submitted" },
        [...SPAWN, fauxAssistantMessage("There are 3 files.")],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask;
            yield* answer(yield* firstBrief(events), "accept");

            const item = yield* deliveredItem(parent);

            assert.strictEqual(item.status, "settled");
            assert.deepStrictEqual(
              item.settlements.map((mark) => mark.outcome),
              ["failed"]
            );

            const transcript = yield* transcriptOf(parent);

            assert.include(transcript, "Cairn could not follow this input");
            assert.include(transcript, PLANTED);
          })
      ),
    30_000
  );

  it.live(
    "a reporter that throws after its run settled still writes the result's note",
    () =>
      withBrain(
        { crash: "reporter-settled" },
        [...SPAWN, fauxAssistantMessage("There are 3 files.")],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* ask;
            yield* answer(yield* firstBrief(events), "accept");

            const item = yield* deliveredItem(parent);

            assert.deepStrictEqual(
              item.settlements.map((mark) => mark.outcome),
              ["completed"]
            );

            yield* transcriptHolds(
              parent,
              "<subagent_result>\nThere are 3 files.\n</subagent_result>"
            );
          })
      ),
    30_000
  );
});
