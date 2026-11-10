// The approvals feature's manifest (ADR 0053): the approval ledger's records and the `ask_user`
// tool (ADR 0013, ADR 0029). Everything it registers with the brain and the app is listed here, and
// `Features.ts` lists this manifest.

import { Layer } from "effect";

import { bootRepair, placed, RepairOrder } from "../BootRepair.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import {
  cancelAbandonedApprovalsAtBoot,
  expireLapsedApprovalsAtBoot,
} from "./ApprovalLedger.ts";
import { askUserSource } from "./AskUserTool.ts";

/** What the approvals feature registers. */
export const ApprovalsFeature = {
  name: "approvals",
  extensionSources: [askUserSource],
  extensionLayer: Layer.empty,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [
    placed(
      RepairOrder.cancelAbandonedApprovals,
      bootRepair("cancel abandoned approvals", cancelAbandonedApprovalsAtBoot)
    ),
    placed(
      RepairOrder.expireLapsedApprovals,
      bootRepair("expire lapsed approvals", expireLapsedApprovalsAtBoot)
    ),
  ],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: Layer.empty,
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
