// The two harnesses the conformance suite judges, each built over a scenario's response script and
// restartable over the same store:
//
// - pi-durable: the production seam, brain and extension set (plus the conformance tools) over a
//   temporary `brain.sqlite`, with pi-ai's faux provider answering from the script. A restart
//   closes the Harness (as SIGTERM does) and opens a new one over the same file, then resumes.
// - scripted: ScriptedHarness over one ScriptedStore that outlives its instances.
//
// The in-process restart is a clean close. The durability judge does the `kill -9` restarts.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ThreadId } from "@cairn/protocol/Ids";
import type { RuntimeMode } from "@cairn/protocol/Policy";
import { Context, Effect, Exit, Layer, Option, Ref, Scope } from "effect";

import { ExecutorLink } from "../../executor/ExecutorLink.ts";
import { ModelHealth } from "../../models/ModelHealth.ts";
import { PiHost } from "../../pi-host/PiHost.ts";
import { Brain } from "../Brain.ts";
import { BrainConfig } from "../BrainConfig.ts";
import { ExtensionSet } from "../ExtensionSet.ts";
import { FauxModels } from "../FauxModels.ts";
import { HarnessSeam } from "../HarnessSeam.ts";
import type { HarnessError } from "../HarnessSeam.ts";
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
import type { ResponseScript } from "./ResponseScript.ts";

/** One harness under judgement. */
export interface ConformanceTarget {
  /** The seam of the instance now open. */
  readonly seam: Effect.Effect<HarnessSeam["Service"]>;
  /** Lets the open instance schedule work; called once its subscribers are in place. */
  readonly resume: Effect.Effect<void>;
  /** Closes the instance and opens another over the same store, not yet resumed. */
  readonly restart: Effect.Effect<void>;
  /**
   * Sets a thread's permission mode, refusing a child's widening (ADR 0031); none where the
   * harness has no way to set one yet.
   */
  readonly setMode: Effect.Effect<Option.Option<SetMode>>;
}

/** Sets one thread's permission mode. */
export type SetMode = (
  threadId: ThreadId,
  mode: RuntimeMode
) => Effect.Effect<void, HarnessError>;

/** One open instance of a harness. */
interface Instance {
  readonly seam: HarnessSeam["Service"];
  readonly resume: Effect.Effect<void>;
  readonly setMode: Option.Option<SetMode>;
}

/** Builds a target over a scenario's script and planted delivery faults, for one scenario. */
export type MakeTarget = (
  script: ResponseScript,
  faults: SubagentFaultSet
) => Effect.Effect<ConformanceTarget, never, Scope.Scope>;

/** Answers more requests than any scenario makes; each takes the script's next answer. */
const FAUX_STEPS = 64;

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
    setMode: Effect.map(Ref.get(current), ({ instance }) => instance.setMode),
    restart: Effect.gen(function* () {
      const { scope } = yield* Ref.get(current);

      yield* Scope.close(scope, Exit.void);
      yield* Ref.set(current, yield* openOne);
    }),
  } satisfies ConformanceTarget;
});

/** The pi-durable side. */
// The subagent faults reach pi-durable with the subagents extension; until then it plants none.
export const piDurableTarget: MakeTarget = (script) =>
  Effect.gen(function* () {
    const dataDir = mkdtempSync(path.join(tmpdir(), "cairn-conformance-"));

    const layer = PiDurableHarness.layer.pipe(
      Layer.provide(
        ExtensionSet.withExtra([conformanceTools]).pipe(
          Layer.provide(ExecutorLink.layerDisabled),
          Layer.provide(PiHost.layerEmpty),
          Layer.provide(ModelHealth.layerTest)
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
      Layer.provide(BrainConfig.layerFrom(dataDir))
    );

    return yield* restartable(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const { faux } = Context.get(context, FauxModels);
        const run = Effect.runPromiseWith(yield* Effect.context());

        faux.setResponses(
          Array.from(
            { length: FAUX_STEPS },
            () => async (_request, options) =>
              await run(
                script.next(
                  Option.fromUndefinedOr(options?.signal),
                  Option.none()
                )
              )
          )
        );

        return {
          seam: Context.get(context, HarnessSeam),
          resume: Context.get(context, Brain).resume.pipe(Effect.orDie),
          // A thread's permission mode reaches the seam with `ThreadAgentChange.runtimeMode`.
          setMode: Option.none(),
        };
      }).pipe(Effect.orDie)
    );
  });

/** The scripted side. */
export const scriptedTarget: MakeTarget = (script, faults) =>
  Effect.gen(function* () {
    const store = yield* Layer.build(ScriptedStore.layer);

    const model = Layer.succeed(
      ScriptedModel,
      ScriptedModel.of({
        answer: (request) =>
          script.next(Option.none(), Option.some(request.threadId)),
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
        setMode: Option.none(),
      }))
    );
  });
