// The executor feature's manifest (ADR 0053): MCP tools through Executor (ADR 0003). Everything it
// registers with the brain and the app is listed here, and `Features.ts` lists this manifest.
//
// The `ExecutorLink` its extension and handlers read is the root's: the real link in `main.ts`
// only, a fake one in dev and judge brains, the disabled one in tests.

import { Layer } from "effect";

import { bootRepair, placed, RepairOrder } from "../BootRepair.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import { ExecutorExtension } from "./ExecutorExtension.ts";
import { ExecutorHandlers } from "./ExecutorHandlers.ts";
import { sweepUnfinishedExecutorRequests } from "./ExecutorSweep.ts";

/** What the executor feature registers. */
export const ExecutorFeature = {
  name: "executor",
  extensionSources: [
    ExecutorExtension.useSync((executor) => executor.extension),
  ],
  extensionLayer: ExecutorExtension.layer,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [
    placed(
      RepairOrder.executorSweep,
      bootRepair("executor-sweep", sweepUnfinishedExecutorRequests)
    ),
  ],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: ExecutorHandlers,
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
