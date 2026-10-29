// The two harnesses the conformance suite judges, each built over a scenario's response script and
// restartable over the same store:
//
// - pi-durable: the production seam, brain and extension set (plus the conformance tools) over a
//   temporary `brain.sqlite`, with pi-ai's faux provider answering from the script. A restart
//   closes the Harness (as SIGTERM does) and opens a new one over the same file, then resumes.
//   Each faux request is mapped to the thread that asks, by the provider session id pi-durable
//   passes (`pi.provider`, one per conversation) joined to the conversation's `cairn.thread-meta`,
//   so a model line's `thread` alias holds on pi-durable as it does on the scripted side.
// - scripted: ScriptedHarness over one ScriptedStore that outlives its instances.
//
// The in-process restart is a clean close. The durability judge does the `kill -9` restarts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@cairn/protocol/Ids";
import type { Context as AiContext, Message } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { ProviderDoc } from "@earendil-works/pi-durable";
import {
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect";

import { ServerConfig } from "../../Config.ts";
import { Database } from "../../db/Database.ts";
import { migrations } from "../../db/Migrations.ts";
import { ExecutorLink } from "../../executor/ExecutorLink.ts";
import { ModelHealth } from "../../models/ModelHealth.ts";
import { PiModelSource } from "../../models/PiModelSource.ts";
import { SettingsStore } from "../../models/SettingsStore.ts";
import { PiHost } from "../../pi-host/PiHost.ts";
import { ReachServicesTest } from "../../reach/ReachLayer.ts";
import {
  subagentsExtension,
  workspaceAccess,
} from "../../subagents/Subagents.ts";
import { DEFAULT_TOOL_OPTIONS } from "../../subagents/SubagentTools.ts";
import type { SubagentToolOptions } from "../../subagents/SubagentTools.ts";
import { ChildWorkspaces } from "../../workspaces/ChildWorkspaces.ts";
import { Brain } from "../Brain.ts";
import type { BrainSession } from "../Brain.ts";
import { BrainConfig } from "../BrainConfig.ts";
import { ThreadMeta } from "../CairnDocs.ts";
import { messageText } from "../CommitFeed.ts";
import { durable } from "../Durable.ts";
import { ExtensionSet } from "../ExtensionSet.ts";
import { FauxModels } from "../FauxModels.ts";
import { HarnessSeam } from "../HarnessSeam.ts";
import { ModelSource } from "../ModelSource.ts";
import { PiDurableHarness } from "../PiDurableHarness.ts";
import {
  ScriptedBoot,
  ScriptedHarness,
  ScriptedModel,
  ScriptedStore,
} from "../ScriptedHarness.ts";
import { SubagentFaults } from "../SubagentFaults.ts";
import type { SubagentFaultSet } from "../SubagentFaults.ts";
import {
  conformanceTools,
  scriptedConformanceTools,
} from "./ConformanceTools.ts";
import type { ResponseScript, SeenRequest } from "./ResponseScript.ts";

/** One harness under judgement. */
export interface ConformanceTarget {
  /** The seam of the instance now open. */
  readonly seam: Effect.Effect<HarnessSeam["Service"]>;
  /** Lets the open instance schedule work; called once its subscribers are in place. */
  readonly resume: Effect.Effect<void>;
  /** Closes the instance and opens another over the same store, not yet resumed. */
  readonly restart: Effect.Effect<void>;
}

/** One open instance of a harness. */
interface Instance {
  readonly seam: HarnessSeam["Service"];
  readonly resume: Effect.Effect<void>;
}

/** Builds a target over a scenario's script and planted delivery faults, for one scenario. */
export type MakeTarget = (
  script: ResponseScript,
  faults: SubagentFaultSet
) => Effect.Effect<ConformanceTarget, never, Scope.Scope>;

/** Answers more requests than any scenario makes; each takes the script's next answer. */
const FAUX_STEPS = 64;

/** More conversations than any scenario makes. */
const CONVERSATION_SCAN = 256;

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/**
 * The thread whose conversation holds the provider session id `sessionId`, learning every
 * conversation's on a miss; none when no thread has it (or the read failed).
 */
const threadOfSession = (
  session: BrainSession,
  known: Map<string, ThreadId>,
  sessionId: string
) =>
  Effect.gen(function* () {
    const cached = known.get(sessionId);

    if (cached !== undefined) {
      return Option.some(cached);
    }

    const { harness } = session;

    const page = yield* durable(
      "scan-conversations",
      async (context) =>
        await harness.commit(
          async (tx) => await tx.scanConversations({}, CONVERSATION_SCAN),
          context
        )
    );

    for (const conversation of page.items) {
      const [provider, meta] = yield* durable(
        "thread-of-session",
        async (context) =>
          await Promise.all([
            harness.snapshot(ProviderDoc, conversation.id, context),
            harness.snapshot(ThreadMeta, conversation.id, context),
          ])
      );

      const thread = decodeThreadId(meta?.threadId);

      if (provider !== undefined && Option.isSome(thread)) {
        known.set(provider.sessionId, thread.value);
      }
    }

    return Option.fromUndefinedOr(known.get(sessionId));
  }).pipe(Effect.orElseSucceed(() => Option.none<ThreadId>()));

/** The text of the first user message of `messages`; empty without one. */
const firstInputOf = (messages: ReadonlyArray<Message>) => {
  const first = messages.find((message) => message.role === "user");

  return first === undefined ? "" : messageText(first);
};

/** What a faux request offered and asked first: the tools its transcript declares and its own. */
const seenOf = (request: AiContext): SeenRequest => ({
  tools: [
    ...new Set([
      ...getCurrentTools(request.messages).map((tool) => tool.name),
      ...(request.tools ?? []).map((tool) => tool.name),
    ]),
  ],
  firstInput: firstInputOf(request.messages),
});

/** A target whose instance `open` builds, rebuilt on restart inside the caller's scope. */
const restartable = Effect.fnUntraced(function* (
  open: Effect.Effect<Instance, never, Scope.Scope>
) {
  const outer = yield* Effect.scope;

  const openOne = Effect.gen(function* () {
    const scope = yield* Scope.fork(outer);
    const instance = yield* open.pipe(Scope.provide(scope));

    return { scope, instance };
  });

  const current = yield* Ref.make(yield* openOne);

  return {
    seam: Effect.map(Ref.get(current), ({ instance }) => instance.seam),
    resume: Effect.flatMap(Ref.get(current), ({ instance }) => instance.resume),
    restart: Effect.gen(function* () {
      const { scope } = yield* Ref.get(current);

      yield* Scope.close(scope, Exit.void);
      yield* Ref.set(current, yield* openOne);
    }),
  } satisfies ConformanceTarget;
});

/**
 * Children's workspaces for a test brain over `dataDir`: worktrees under `<dataDir>/worktrees`, plan
 * rows in a fresh migrated in-memory `cairn.sqlite`.
 */
export const childWorkspacesAt = (dataDir: string) =>
  ChildWorkspaces.layer.pipe(
    Layer.provide(Database.layerTest(migrations)),
    Layer.provide(ServerConfig.layerWith({ dataDir })),
    Layer.orDie
  );

/**
 * The pi-durable brain the conformance suite runs over `dataDir`: the production seam, brain and
 * extension set, the conformance tools and the subagents extension with `faults` (and `tuning`, for a
 * test that needs a question to expire soon), making children's workspaces under `dataDir`
 * (`ChildWorkspaces`, also provided), over pi-ai's faux provider. Subagent tests under `brain/`
 * build on it too.
 */
export const piDurableLayer = (
  dataDir: string,
  faults: SubagentFaultSet,
  tuning: SubagentToolOptions = DEFAULT_TOOL_OPTIONS
) =>
  PiDurableHarness.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const workspaces = workspaceAccess(
            yield* ChildWorkspaces,
            yield* Effect.context()
          );

          return ExtensionSet.withExtra([
            conformanceTools,
            subagentsExtension(faults, workspaces, tuning),
          ]);
        })
      ).pipe(
        Layer.provide(ExecutorLink.layerDisabled),
        Layer.provide(PiHost.layerEmpty),
        Layer.provide(ModelHealth.layerTest),
        Layer.provide(SettingsStore.layerTest),
        Layer.provide(ReachServicesTest),
        Layer.provide(PiModelSource.layerFromModelSource)
      )
    ),
    Layer.provideMerge(
      ModelSource.layerFaux({
        tokensPerSecond: 2000,
        // No provider retries (a failed answer would take the next scripted one), and a
        // compaction keeps only the newest context, so a short thread has something to compact.
        settings: {
          retry: { enabled: false },
          compaction: { keepRecentTokens: 1 },
        },
      })
    ),
    Layer.provideMerge(childWorkspacesAt(dataDir)),
    Layer.provide(BrainConfig.layerFrom(dataDir))
  );

/**
 * The pi-durable side, with the subagents extension, the faults the mutation check plants and
 * `tuning` (a test that orders the reporters of a shared run passes its own).
 */
export const piDurableTargetWith =
  (tuning: SubagentToolOptions): MakeTarget =>
  (script, faults) =>
    Effect.gen(function* () {
      const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-conformance-"));
      const layer = piDurableLayer(dataDir, faults, tuning);

      return yield* restartable(
        Effect.gen(function* () {
          const context = yield* Layer.build(layer);
          const { faux } = Context.get(context, FauxModels);
          const brain = Context.get(context, Brain);
          const run = Effect.runPromiseWith(yield* Effect.context());
          const known = new Map<string, ThreadId>();

          // The asking thread, from the request's provider session id.
          const askingThread = (sessionId: string | undefined) =>
            Effect.gen(function* () {
              const session = yield* Effect.option(brain.session);

              if (sessionId === undefined || Option.isNone(session)) {
                return Option.none<ThreadId>();
              }

              return yield* threadOfSession(session.value, known, sessionId);
            });

          faux.setResponses(
            Array.from(
              { length: FAUX_STEPS },
              () => async (request, options) =>
                await run(
                  Effect.gen(function* () {
                    const thread = yield* askingThread(options?.sessionId);

                    return yield* script.next(
                      Option.fromUndefinedOr(options?.signal),
                      thread,
                      seenOf(request)
                    );
                  })
                )
            )
          );

          return {
            seam: Context.get(context, HarnessSeam),
            resume: brain.resume.pipe(Effect.orDie),
          };
        }).pipe(Effect.orDie)
      );
    });

/** The pi-durable side with the production tuning. */
export const piDurableTarget: MakeTarget =
  piDurableTargetWith(DEFAULT_TOOL_OPTIONS);

/** The scripted side. */
export const scriptedTarget: MakeTarget = (script, faults) =>
  Effect.gen(function* () {
    const store = yield* Layer.build(ScriptedStore.layer);

    const model = Layer.succeed(
      ScriptedModel,
      ScriptedModel.of({
        answer: (request) =>
          script.next(Option.none(), Option.some(request.threadId), {
            tools: request.tools,
            firstInput: firstInputOf(request.messages),
          }),
      })
    );

    const layer = ScriptedHarness.layerNoDeps.pipe(
      Layer.provide(Layer.succeedContext(store)),
      Layer.provide(model),
      Layer.provide(scriptedConformanceTools),
      Layer.provide(Layer.succeed(SubagentFaults, faults))
    );

    return yield* restartable(
      Effect.map(Layer.build(layer), (context) => ({
        seam: Context.get(context, HarnessSeam),
        resume: Context.get(context, ScriptedBoot).resume,
      }))
    );
  });
