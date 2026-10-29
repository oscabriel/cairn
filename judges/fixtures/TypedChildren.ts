// J-typed through real subagent children (plan 4F; subagents note S8): every trial is a child the
// subagents extension (3A) starts from an approved brief, on the production extension set over
// pi's real model runtime. Per trial:
//
// 1. A parent thread on a scripted model (pi-ai's faux provider, registered beside the real ones)
//    calls `subagent_spawn` with the probe task as its brief, the task's schema as its
//    `result_schema` and `wake: quiet`, then ends its run.
// 2. The judge moves the parent onto the model under test and says Go. The child runs on what its
//    dispatch record names, the parent's model, with `submit_result` offered.
// 3. A child that ends with no result gets 3A's reporter's one nudge; the judge waits for the
//    registry to settle the child, declining any approval the child asks for meanwhile.
// 4. The trial is judged from the child's transcript, its `cairn.result` and the parent's dispatch
//    record (`judgeTrial`): the dispatched and returned models must both be the one asked for.
//
// The parent never runs on the real model: Go is a note and a quiet settlement does not wake it.
//
// pi-durable is imported here, under `judges/fixtures/` (S42).

import { ApprovalId } from "@cairn/protocol/Ids";
import type { ConversationId, ThreadId } from "@cairn/protocol/Ids";
import type { ModelRef } from "@cairn/protocol/Models";
import type { Message, Provider } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type {
  FauxProviderHandle,
  FauxResponseFactory,
} from "@earendil-works/pi-ai/providers/faux";
import {
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect";

import { Brain } from "../../apps/server/src/brain/Brain.ts";
import { BrainConfig } from "../../apps/server/src/brain/BrainConfig.ts";
import { childWorkspacesAt } from "../../apps/server/src/brain/conformance/Targets.ts";
import { durable } from "../../apps/server/src/brain/Durable.ts";
import { ExtensionSet } from "../../apps/server/src/brain/ExtensionSet.ts";
import { HarnessSeam } from "../../apps/server/src/brain/HarnessSeam.ts";
import type { HarnessEvent } from "../../apps/server/src/brain/HarnessSeam.ts";
import { FAUX_MODEL } from "../../apps/server/src/brain/ModelSource.ts";
import { PiDurableHarness } from "../../apps/server/src/brain/PiDurableHarness.ts";
import { piConversationId } from "../../apps/server/src/brain/PiIds.ts";
import { NO_SUBAGENT_FAULTS } from "../../apps/server/src/brain/SubagentFaults.ts";
import { ServerConfig } from "../../apps/server/src/Config.ts";
import { ExecutorLink } from "../../apps/server/src/executor/ExecutorLink.ts";
import { BridgeProvider } from "../../apps/server/src/models/BridgeProvider.ts";
import { ModelHealth } from "../../apps/server/src/models/ModelHealth.ts";
import {
  ExtraProviders,
  PiModelSource,
} from "../../apps/server/src/models/PiModelSource.ts";
import { readResult } from "../../apps/server/src/models/ResultTool.ts";
import { SettingsStore } from "../../apps/server/src/models/SettingsStore.ts";
import { PiHost } from "../../apps/server/src/pi-host/PiHost.ts";
import { ReachServicesTest } from "../../apps/server/src/reach/ReachLayer.ts";
import {
  createProject,
  testThreadId,
} from "../../apps/server/src/shell/ShellTestKit.ts";
import { SubagentsDoc } from "../../apps/server/src/subagents/SubagentDocs.ts";
import { Subagents } from "../../apps/server/src/subagents/Subagents.ts";
import { judgeTrial, REPORT_SCHEMA, TASK } from "./TypedResults.ts";
import type { Trial } from "./TypedResults.ts";

/** How often the judge looks at the brain's events while it waits. */
const POLL = Duration.millis(200);

/** The project every parent thread names; nothing reads it here. */
const PROJECT = createProject(1).projectId;

/** The brief's title. */
const DESCRIPTION = "Report on a small repository";

/** The parent's scripted model: pi-ai's faux provider, beside the real ones. */
export const scriptedParent = (): FauxProviderHandle =>
  fauxProvider({
    provider: FAUX_MODEL.provider,
    models: [{ id: FAUX_MODEL.modelId, contextWindow: 200_000 }],
    tokensPerSecond: 2000,
  });

/**
 * The parent's every answer: the spawn of the typed brief, or, once the spawn's result is back,
 * a line that ends its run.
 */
const parentStep: FauxResponseFactory = (transcript) => {
  const last = transcript.messages.at(-1);

  if (last?.role === "toolResult") {
    return fauxAssistantMessage("Waiting for Go.");
  }

  return fauxAssistantMessage(
    fauxToolCall("subagent_spawn", {
      description: DESCRIPTION,
      brief: TASK,
      result_schema: REPORT_SCHEMA,
      wake: "quiet",
    }),
    { stopReason: "toolUse" }
  );
};

/** Scripts the parent model for `parents` parents, each answering twice, with room to spare. */
export const scriptParents = (parent: FauxProviderHandle, parents: number) => {
  parent.setResponses(
    Array.from({ length: parents * 2 + 8 }, () => parentStep)
  );
};

/**
 * The brain J-typed's children run in, over `dataDir`: the production seam, brain and extension
 * set (subagents with no faults, results, roles, the bridge's cwd), pi's model runtime read-only
 * over `~/.pi/agent` with `parent` registered beside the bridge when `BridgeProvider` has one, and
 * children's workspaces under `dataDir`. Needs `BridgeProvider`.
 */
export const childBrain = (dataDir: string, parent: Provider) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      ExtensionSet.layer.pipe(
        Layer.provide(Subagents.layerWith(NO_SUBAGENT_FAULTS)),
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ModelHealth.layerTest),
        Layer.provide(SettingsStore.layerTest),
        Layer.provide(ReachServicesTest)
      )
    ),
    Layer.provideMerge(
      PiModelSource.layer.pipe(
        Layer.provide(
          Layer.effect(
            ExtraProviders,
            BridgeProvider.useSync((bridge) => [
              ...Option.toArray(
                Option.map(bridge.claude, (claude) => claude.provider)
              ),
              parent,
            ])
          )
        ),
        Layer.provide(ServerConfig.layerWith({ dataDir })),
        Layer.orDie
      )
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

/** The trial did not reach its end. */
class ChildTrialStuck extends Schema.TaggedError<ChildTrialStuck>()(
  "ChildTrialStuck",
  { message: Schema.String, step: Schema.String }
) {}

/** The model a dispatch record names, read as the judge's own shape. */
const DispatchModel = Schema.Struct({
  resolved: Schema.Struct({
    model: Schema.Struct({ provider: Schema.String, modelId: Schema.String }),
  }),
});

const decodeDispatch = Schema.decodeUnknownOption(DispatchModel);

/** The brain's events so far, in commit order, for trials to wait on. */
export type EventLog = Ref.Ref<ReadonlyArray<HarnessEvent>>;

/**
 * Starts recording the brain's events into a log for the scope's life, then resumes the brain, as
 * boot does once its repairs ran.
 */
export const openBrain = Effect.gen(function* () {
  const seam = yield* HarnessSeam;
  const log: EventLog = yield* Ref.make<ReadonlyArray<HarnessEvent>>([]);

  yield* seam.events.pipe(
    Stream.runForEach((event) => Ref.update(log, (all) => [...all, event])),
    Effect.forkScoped
  );

  yield* Effect.flatMap(Brain, (brain) => brain.resume);

  return log;
});

/** Polls the log until `pick` accepts an event. */
const eventWhere = <A>(
  log: EventLog,
  step: string,
  pick: (event: HarnessEvent) => Option.Option<A>
) =>
  Effect.gen(function* () {
    for (;;) {
      const found = Option.firstSomeOf((yield* Ref.get(log)).map(pick));

      if (Option.isSome(found)) {
        return found.value;
      }

      yield* Effect.sleep(POLL);
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.minutes(10),
      orElse: () =>
        Effect.fail(
          new ChildTrialStuck({
            message: `Waited ten minutes for ${step}.`,
            step,
          })
        ),
    })
  );

/** What the child is known by once it started. */
interface StartedChild {
  readonly threadId: ThreadId;
  readonly conversationId: ConversationId;
}

/**
 * Declines every approval `child` asks for until it settles in `parent`'s registry: a gated tool in
 * the narrowed mode would otherwise wait for a user who is not there.
 */
const settleDecliningApprovals = (
  log: EventLog,
  parent: ThreadId,
  child: ThreadId
) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const declined = new Set<string>();

    for (;;) {
      const events = yield* Ref.get(log);

      const settled = events.some(
        (event) =>
          Predicate.isTagged(event, "SubagentUpdated") &&
          event.threadId === parent &&
          event.child === child &&
          event.status === "settled"
      );

      if (settled) {
        return;
      }

      for (const event of events) {
        if (
          Predicate.isTagged(event, "RuntimeRequestUpdated") &&
          event.threadId === child &&
          event.status === "pending" &&
          !declined.has(event.id)
        ) {
          declined.add(event.id);

          yield* seam
            .respond(child, event.id, {
              decision: "decline",
              reason: Option.some(
                "Not in this task. Report with submit_result."
              ),
              answers: Option.none(),
            })
            .pipe(Effect.ignore);
        }
      }

      yield* Effect.sleep(POLL);
    }
  });

/** The child's messages, its `cairn.result` and the parent's dispatch record for it. */
const readChild = (parent: ConversationId, child: StartedChild) =>
  Effect.gen(function* () {
    const { harness } = yield* Brain.use((brain) => brain.session);

    return yield* durable("typed-results.readChild", async (signal) => {
      const childId = piConversationId(child.conversationId);
      const handle = await harness.conversation(childId, signal);

      const transcript =
        handle === undefined ? undefined : await handle.context(signal);

      const messages: ReadonlyArray<Message> = transcript?.messages ?? [];

      const stored = await readResult(harness, childId, signal);

      const registry = await harness.snapshot(
        SubagentsDoc,
        piConversationId(parent),
        signal
      );

      const item = Object.values(registry?.items ?? {}).find(
        (found) => found.threadId === child.threadId
      );

      const dispatched = Option.map(
        decodeDispatch(item?.dispatch),
        (record): ModelRef => record.resolved.model
      );

      return { messages, stored, dispatched };
    });
  });

/**
 * One trial: parent `index`'s spawn, Go on `model`, the child settled, and its verdict. A trial
 * that cannot finish is a failed trial with the step it stopped at.
 */
const oneChild = (log: EventLog, model: ModelRef, index: number, cwd: string) =>
  Effect.gen(function* () {
    const seam = yield* HarnessSeam;
    const parent = testThreadId(index);

    const ensured = yield* seam.ensureThread({
      threadId: parent,
      projectId: PROJECT,
      model: FAUX_MODEL,
      thinkingLevel: "off",
      cwd,
      instructions: Option.none(),
      runtimeMode: "approval-required",
    });

    yield* seam.submit(parent, {
      requestId: `typed-${String(index)}`,
      content: [{ type: "text", text: "Delegate the review." }],
      entry: Option.none(),
      whenBusy: "followUp",
    });

    const brief = yield* eventWhere(log, "the brief", (event) =>
      Predicate.isTagged(event, "RuntimeRequestUpdated") &&
      event.threadId === parent &&
      event.kind === "brief" &&
      event.status === "pending"
        ? Option.some(event.id)
        : Option.none()
    );

    yield* eventWhere(log, "the parent's run to end", (event) =>
      Predicate.isTagged(event, "RunTerminal") && event.threadId === parent
        ? Option.some(event.status)
        : Option.none()
    );

    // The child runs on its parent's model (2D's rule until 4A resolves roles at Go).
    yield* seam.configure(parent, {
      model: Option.some(model),
      thinkingLevel: Option.none(),
      cwd: Option.none(),
      runtimeMode: Option.none(),
    });

    yield* seam.respond(parent, ApprovalId.make(brief), {
      decision: "accept",
      reason: Option.none(),
      answers: Option.none(),
    });

    const child = yield* eventWhere(log, "the child", (event) =>
      Predicate.isTagged(event, "ThreadEnsured") &&
      Option.exists(event.parent, (found) => found === parent)
        ? Option.some({
            threadId: event.threadId,
            conversationId: event.conversationId,
          })
        : Option.none()
    );

    yield* settleDecliningApprovals(log, parent, child.threadId).pipe(
      Effect.timeoutOrElse({
        duration: Duration.minutes(10),
        orElse: () =>
          Effect.fail(
            new ChildTrialStuck({
              message: "Waited ten minutes for the child to settle.",
              step: "the settlement",
            })
          ),
      })
    );

    const read = yield* readChild(ensured.conversationId, child);

    return judgeTrial({ ...read, requested: model });
  });

/** A trial that stopped before its verdict, recorded as a failed one. */
const stuck = (model: ModelRef, why: string): Trial => ({
  valid: false,
  stored: false,
  schemaValid: false,
  failure: why,
  factsRight: false,
  factsFailure: "none stored",
  attempts: 0,
  storedAttempts: 0,
  nudged: false,
  returnedModel: "none",
  dispatchedModel: "none",
  modelMatches: false,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  error: `${model.provider}/${model.modelId}: ${why}`,
  rejections: [],
});

/**
 * Runs `trials` typed children on `model` at once, numbering their parents from `first`, each
 * parent (and so each shared child) working in `cwd`, and judges each. Needs the brain
 * `childBrain` builds, opened by `openBrain`, its parent model scripted.
 */
export const runChildTrials = (
  log: EventLog,
  model: ModelRef,
  trials: number,
  first: number,
  cwd: string
) =>
  Effect.forEach(
    Array.from({ length: trials }, (_, index) => first + index),
    (index) =>
      oneChild(log, model, index, cwd).pipe(
        Effect.result,
        Effect.map(Result.getOrElse((failure) => stuck(model, failure.message)))
      ),
    { concurrency: "unbounded" }
  );
