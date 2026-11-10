// The subagents feature's manifest (ADR 0053): children with their own threads (ADR 0028), their
// briefs (ADR 0030) and their questions (ADR 0027). Everything it registers with the brain and the
// app is listed here, and `Features.ts` lists this manifest.
//
// The `Subagents` service the extension reads is the root's (`PiDurableBrain`), over the app's
// child workspaces; a judge brain gives one with planted faults.

import { Effect, Layer } from "effect";

import { bootRepair, placed, RepairOrder } from "../BootRepair.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import {
  ChildDoc,
  EscalationsDoc,
  SubagentsDoc,
} from "../brain/SubagentDocs.ts";
import { BriefFaults } from "./BriefFaults.ts";
import { repairChildWorkspacesAtBoot } from "./ChildWorkspaceRepair.ts";
import { holdWakes } from "./Delivery.ts";
import { QuestionRoutes } from "./QuestionRoute.ts";
import {
  repairSubagentRows,
  retitleSubagentRows,
  SubagentRows,
} from "./SubagentRows.ts";
import { answerBrief, steerReporter, Subagents } from "./Subagents.ts";
import { SUBAGENT_WAIT_TASKS } from "./SubagentTasks.ts";
import { SUBAGENT_STATUS_TOOL } from "./SubagentTools.ts";

/** What the subagents feature registers. */
export const SubagentsFeature = {
  name: "subagents",
  extensionSources: [Subagents.useSync((subagents) => subagents.extension)],
  extensionLayer: Layer.empty,
  documents: [SubagentsDoc, ChildDoc, EscalationsDoc],
  answered: [Effect.map(BriefFaults, answerBrief)],
  steer: [steerReporter],
  holdWakes: [holdWakes],
  bootRepairs: [
    placed(
      RepairOrder.subagentRows,
      bootRepair("subagent rows", repairSubagentRows)
    ),
    placed(
      RepairOrder.subagentTitles,
      bootRepair("subagent titles", retitleSubagentRows)
    ),
    placed(
      RepairOrder.childWorkspaces,
      bootRepair("child workspace repair", repairChildWorkspacesAtBoot)
    ),
  ],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [...SUBAGENT_WAIT_TASKS], tools: [SUBAGENT_STATUS_TOOL] },
  handlers: Layer.empty,
  harnessLayer: Layer.empty,
  appLayer: Layer.mergeAll(SubagentRows, QuestionRoutes),
} satisfies CairnFeature;
