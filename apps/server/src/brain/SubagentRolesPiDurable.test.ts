// A brief's role and the brain's cap over a real pi-durable brain (the conformance suite's
// composition, with the settings store in reach so a test can change the role table):
//
// - an `@role` alias resolves at Go to its binding's model and level, which the child runs on
//   (`pi.agent`) and its dispatch record names;
// - a role nothing ready answers to at the ask is refused there, naming the roles that resolve now;
// - a role that resolved at the ask but not at Go (the table changed) starts nothing, and the
//   parent is told once;
// - the brain-wide cap (`maxLivePerBrain`, 32 in production, 2 here) counts every thread's
//   children: a second thread's spawn past it is refused, while its own cap of 8 is far off.
//
// Kept under `brain/`, where pi-durable may be imported in a test (S42).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ApprovalId, ProjectId } from "@cairn/protocol/Ids";
import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import { DEFAULT_ROLE_TABLE, RoleName } from "@cairn/protocol/Roles";
import type { RoleTable } from "@cairn/protocol/Roles";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc } from "@earendil-works/pi-durable";
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
import { SubagentsDoc } from "../subagents/SubagentDocs.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { DEFAULT_TOOL_OPTIONS } from "../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../subagents/SubagentTools.ts";
import { Brain } from "./Brain.ts";
import { BrainConfig } from "./BrainConfig.ts";
import { Approvals } from "./CairnDocs.ts";
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
import { NO_SUBAGENT_FAULTS } from "./SubagentFaults.ts";
import { renderBriefAnswer, SubagentToolText } from "./SubagentText.ts";

const PARENT = testThreadId(1);

const OTHER_PARENT = testThreadId(2);

/** The brain the conformance suite runs, with `SettingsStore` and `ModelHealth` left in reach. */
const brainLayer = (dataDir: string, tuning: SubagentToolOptions) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.withExtra([conformanceTools]).pipe(
        Layer.provide(Subagents.layerWith(NO_SUBAGENT_FAULTS, tuning)),
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ReachServicesTest),
        Layer.provide(PiModelSource.layerFromModelSource)
      )
    ),
    Layer.provideMerge(ModelHealth.layerTest),
    Layer.provideMerge(SettingsStore.layerTest),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        settings: { retry: { enabled: false } },
      })
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

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

/** What a test body gets: the brain's events so far and the parent's conversation. */
interface Running {
  readonly events: Ref.Ref<ReadonlyArray<HarnessEvent>>;
  readonly parent: ConversationId;
}

/** A spawn of `description` with `role`, as the faux model calls it. */
const spawnCall = (description: string, role: string | null, id: string) => {
  const brief = `${description}, please.`;

  if (role === null) {
    return fauxToolCall("subagent_spawn", { description, brief }, { id });
  }

  return fauxToolCall("subagent_spawn", { description, brief, role }, { id });
};

/** Ensures `threadId` on the faux model at level `off`. */
const ensure = (threadId: ThreadId) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.ensureThread({
      threadId,
      projectId: ProjectId.make("roles"),
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd: process.cwd(),
      instructions: Option.none(),
      runtimeMode: "full-access",
    })
  );

/** Over a fresh brain: the parent thread on the faux model at level `off`, resumed. */
const withBrain = <A, E>(
  tuning: SubagentToolOptions,
  responses: ReadonlyArray<ReturnType<typeof fauxAssistantMessage>>,
  body: (running: Running) => Effect.Effect<A, E, Services>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "cairn-roles-"))),
    (dataDir) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(brainLayer(dataDir, tuning));
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

const ask = (threadId: ThreadId, requestId: string) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.submit(threadId, {
      requestId,
      content: [{ type: "text", text: "delegate it" }],
      entry: Option.none(),
      whenBusy: "followUp",
    })
  );

/** Waits for the `count`th completed run of `threadId`. */
const runsEnded = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId,
  count: number
) =>
  waitFor(
    Effect.map(Ref.get(events), (all) =>
      all.filter(
        (event) =>
          Predicate.isTagged(event, "RunTerminal") &&
          event.threadId === threadId
      ).length >= count
        ? Option.some(true)
        : Option.none()
    )
  );

/** The pending briefs of `threadId`, from the brain's events. */
const pendingBriefs = (
  events: Ref.Ref<ReadonlyArray<HarnessEvent>>,
  threadId: ThreadId
) =>
  Effect.map(Ref.get(events), (all) =>
    all.flatMap((event) =>
      Predicate.isTagged(event, "RuntimeRequestUpdated") &&
      event.threadId === threadId &&
      event.kind === "brief" &&
      event.status === "pending"
        ? [event.id]
        : []
    )
  );

/** Reads through the brain's Harness. */
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

/** Every entry of `conversation`, as one JSON text, to search for what the model read. */
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

/** Binds `@worker` to `model` at `thinkingLevel`, the rest of the table as it ships. */
const bindWorker = (
  model: { readonly provider: string; readonly modelId: string },
  thinkingLevel: "high" | "low"
) =>
  Effect.gen(function* () {
    const settings = yield* SettingsStore;

    const table: RoleTable = {
      ...DEFAULT_ROLE_TABLE,
      [RoleName.make("@worker")]: {
        model,
        thinkingLevel: Option.some(thinkingLevel),
        fallbacks: [],
        note: Option.none(),
      },
    };

    yield* settings.update({
      autoSettleDays: Option.none(),
      titleModel: Option.none(),
      bridgeEnabled: Option.none(),
      bridgeGenerationCap: Option.none(),
      roleBindings: Option.some(table),
      defaultBudget: Option.none(),
    });
  }).pipe(Effect.orDie);

const go = (threadId: ThreadId, approvalId: string) =>
  Effect.flatMap(HarnessSeam, (seam) =>
    seam.respond(threadId, ApprovalId.make(approvalId), {
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
    })
  );

describe("brief roles and the brain's cap over a pi-durable brain", () => {
  it.live(
    "an @role alias resolves at Go to its binding's model and level",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(spawnCall("Count the files", "@worker", "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("There are 3 files."),
          fauxAssistantMessage("Noted."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* bindWorker(FAUX_MODEL, "high");
            yield* ask(PARENT, "r1");

            const [brief] = yield* waitFor(
              Effect.map(pendingBriefs(events, PARENT), (ids) =>
                ids.length > 0 ? Option.some(ids) : Option.none()
              )
            );

            yield* go(PARENT, brief ?? "");

            const child = yield* waitFor(
              Effect.map(Ref.get(events), (all) =>
                Option.firstSomeOf(
                  all.map((event) =>
                    Predicate.isTagged(event, "ThreadEnsured") &&
                    Option.isSome(event.parent)
                      ? Option.some(event.conversationId)
                      : Option.none()
                  )
                )
              )
            );

            const { agent, registry } = yield* read(
              "test.child",
              async (harness, context) => ({
                agent: await harness.snapshot(
                  AgentDoc,
                  piConversationId(child),
                  context
                ),
                registry: await harness.snapshot(
                  SubagentsDoc,
                  piConversationId(parent),
                  context
                ),
              })
            );

            assert.deepStrictEqual(
              {
                provider: agent?.model?.provider,
                modelId: agent?.model?.modelId,
              },
              FAUX_MODEL
            );
            // The parent runs at `off`; the binding's `high` is the child's.
            assert.strictEqual(agent?.thinkingLevel, "high");

            const dispatched = Object.values(registry?.items ?? {})[0]
              ?.dispatch;

            assert.strictEqual(dispatched?.spec, "@worker");
            assert.deepInclude(dispatched?.resolved ?? {}, {
              spec: "@worker",
              role: "@worker",
              thinkingLevel: "high",
              via: "primary",
              model: FAUX_MODEL,
            });
          })
      ),
    30_000
  );

  it.live(
    "a role nothing ready answers to is refused at the ask, naming the roles that resolve now",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(spawnCall("Count the files", "@nobody", "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("That role was refused."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* bindWorker(FAUX_MODEL, "high");
            yield* ask(PARENT, "r1");
            yield* runsEnded(events, PARENT, 1);

            const transcript = yield* transcriptOf(parent);

            assert.include(
              transcript,
              JSON.stringify(
                "subagent_spawn's role does not resolve now."
              ).slice(1, -1)
            );
            assert.include(transcript, "@worker");
            assert.deepStrictEqual(yield* pendingBriefs(events, PARENT), []);
          })
      ),
    30_000
  );

  it.live(
    "a role that resolved at the ask but not at Go starts nothing, and the parent is told once",
    () =>
      withBrain(
        DEFAULT_TOOL_OPTIONS,
        [
          fauxAssistantMessage(spawnCall("Count the files", "@worker", "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage("Understood."),
          fauxAssistantMessage("Understood again."),
        ],
        ({ events, parent }) =>
          Effect.gen(function* () {
            yield* bindWorker(FAUX_MODEL, "high");
            yield* ask(PARENT, "r1");

            const [brief] = yield* waitFor(
              Effect.map(pendingBriefs(events, PARENT), (ids) =>
                ids.length > 0 ? Option.some(ids) : Option.none()
              )
            );

            yield* runsEnded(events, PARENT, 1);

            // The table changes while the brief waits: `@worker` now names no model the brain has.
            yield* bindWorker({ provider: "faux", modelId: "gone" }, "low");
            yield* go(PARENT, brief ?? "");
            yield* runsEnded(events, PARENT, 2);
            yield* Effect.sleep(Duration.millis(300));

            const told = renderBriefAnswer("Count the files", {
              kind: "noModel",
              why: "",
            });

            const transcript = yield* transcriptOf(parent);
            const head = JSON.stringify(told).slice(1, -1);

            assert.strictEqual(transcript.split(head).length - 1, 1);

            const record = yield* read(
              "test.record",
              async (harness, context) => {
                const ledger = await harness.snapshot(
                  Approvals,
                  piConversationId(parent),
                  context
                );

                return ledger?.items[brief ?? ""];
              }
            );

            assert.strictEqual(record?.status, "accepted");
            assert.strictEqual(record?.started, null);
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
    "a spawn past the brain's cap is refused, counting another thread's children",
    () =>
      withBrain(
        { ...DEFAULT_TOOL_OPTIONS, maxLivePerBrain: 2 },
        [
          fauxAssistantMessage(spawnCall("Count the files", null, "c1"), {
            stopReason: "toolUse",
          }),
          fauxAssistantMessage("Waiting for Go."),
          fauxAssistantMessage(
            [
              spawnCall("Read the readme", null, "c2"),
              spawnCall("Read the license", null, "c3"),
            ],
            { stopReason: "toolUse" }
          ),
          fauxAssistantMessage("One was refused."),
        ],
        ({ events }) =>
          Effect.gen(function* () {
            yield* ask(PARENT, "r1");
            yield* runsEnded(events, PARENT, 1);

            const other = yield* ensure(OTHER_PARENT);

            yield* ask(OTHER_PARENT, "r2");
            yield* runsEnded(events, OTHER_PARENT, 1);

            assert.lengthOf(yield* pendingBriefs(events, PARENT), 1);
            assert.lengthOf(yield* pendingBriefs(events, OTHER_PARENT), 1);

            const transcript = yield* transcriptOf(other.conversationId);

            assert.include(
              transcript,
              JSON.stringify(SubagentToolText.brainCapReached(2)).slice(1, -1)
            );
          })
      ),
    30_000
  );
});
