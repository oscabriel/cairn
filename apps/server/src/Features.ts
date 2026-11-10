// Every feature the brain runs, as the one ordered list of their manifests (ADR 0053). Each consumer
// folds the whole list: the extension set (`ExtensionSet.ts`), the reactor host (`ReactorSet.ts`),
// the boot repairs (`BootRepairs.ts`), the close hooks (`ShutdownHooks.ts`), the RPC group
// (`rpc/Handlers.ts`, applied in `AppLayer.ts`) and the app's own layers (`AppLayer.ts`). A new
// feature is its folder, with its manifest, and one entry here.
//
// What the order decides, and nothing else: the order of the thread stream's documents (approvals,
// then subagents, workflows and verdicts, as the stream has always carried them) and of the close
// hooks (the bridge's, then the portal sweep's; the reactors' close after every feature's). Where an
// extension installs is its `ExtensionOrder` key, where a boot repair runs its `RepairOrder` key,
// and an answer's hooks act on their own records only. `Features.test.ts` holds all three.

import { ApprovalsFeature } from "./approvals/ApprovalsFeature.ts";
import { AttachmentsFeature } from "./attachments/AttachmentsFeature.ts";
import { ExecutorFeature } from "./executor/ExecutorFeature.ts";
import { ModelsFeature } from "./models/ModelsFeature.ts";
import { PiHostFeature } from "./pi-host/PiHostFeature.ts";
import { PushFeature } from "./push/PushFeature.ts";
import { ReachFeature } from "./reach/ReachFeature.ts";
import { SkillsFeature } from "./skills/SkillsFeature.ts";
import { SubagentsFeature } from "./subagents/SubagentsFeature.ts";
import { UsageFeature } from "./usage/UsageFeature.ts";
import { VerdictsFeature } from "./verdicts/VerdictsFeature.ts";
import { WorkflowsFeature } from "./workflows/WorkflowsFeature.ts";

/** Every feature's manifest, in order. */
export const FEATURES = [
  AttachmentsFeature,
  ExecutorFeature,
  ApprovalsFeature,
  SubagentsFeature,
  WorkflowsFeature,
  VerdictsFeature,
  UsageFeature,
  ModelsFeature,
  ReachFeature,
  PiHostFeature,
  SkillsFeature,
  PushFeature,
] as const;

/** One feature's manifest, as the list holds it. */
export type Feature = (typeof FEATURES)[number];
