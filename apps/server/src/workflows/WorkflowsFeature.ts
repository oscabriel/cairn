// The workflows feature's manifest (ADR 0053): durable scripts and their nodes (ADR 0012 as
// amended), launched through an approved envelope (ADR 0032). Everything it registers with the
// brain and the app is listed here, and `Features.ts` lists this manifest.
//
// The workflow tools check the models a script names through `ModelSpecs.layerNoDeps`, as the
// `models` tool does, and hand the soft line's pushes to `WorkflowPushes.layer`, the outbox the app
// drains through `WorkflowBudgetPush` and the reactor host's dead letters share.

import { Effect, Layer } from "effect";

import type { CairnFeature } from "../brain/Feature.ts";
import { WorkflowsDoc } from "../brain/WorkflowsDoc.ts";
import { ModelSpecs } from "../models/ModelSpecs.ts";
import { Recipes } from "./recipes/Recipes.ts";
import { STOPPER_TASK, workflowBudgetReactor } from "./WorkflowBudget.ts";
import { WorkflowHandlers } from "./WorkflowHandlers.ts";
import { LAUNCH_WATCH_TASK, launchAnswered } from "./WorkflowLaunch.ts";
import { WorkflowPlan } from "./WorkflowPlan.ts";
import { WorkflowBudgetPush, WorkflowPushes } from "./WorkflowPushes.ts";
import { Workflows } from "./Workflows.ts";
import { WorkflowStops } from "./WorkflowStop.ts";
import { AGENT_TOOL, VERIFY_TOOL, WATCH_TASK } from "./WorkflowTools.ts";

/** What the workflows feature registers. */
export const WorkflowsFeature = {
  name: "workflows",
  extensionSources: [Workflows.useSync((workflows) => workflows.extension)],
  extensionLayer: Workflows.layer.pipe(
    Layer.provide(ModelSpecs.layerNoDeps),
    Layer.provide(WorkflowPushes.layer)
  ),
  documents: [WorkflowsDoc],
  answered: [Effect.succeed(launchAnswered)],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [],
  reactors: [workflowBudgetReactor],
  keptWaits: {
    kinds: [WATCH_TASK, STOPPER_TASK, LAUNCH_WATCH_TASK],
    tools: [AGENT_TOOL, VERIFY_TOOL],
  },
  handlers: WorkflowHandlers.layer.pipe(Layer.provide(Recipes.layer)),
  harnessLayer: WorkflowStops.layer,
  appLayer: Layer.mergeAll(WorkflowPlan.layer, WorkflowBudgetPush),
} satisfies CairnFeature;
