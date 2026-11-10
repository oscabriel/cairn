// The usage feature's manifest (ADR 0053): spend, budgets (ADR 0036, ADR 0047) and the usage meter.
// Everything it registers with the brain and the app is listed here, and `Features.ts` lists this
// manifest.
//
// The budget gate reads `BudgetBook.layer`, the book the app gives the spend ledger, `Budgets` and
// the guard, so the memo map builds one.

import { Layer } from "effect";

import { bootRepair, placed, RepairOrder } from "../BootRepair.ts";
import type { CairnFeature } from "../brain/Feature.ts";
import { SpendFeed } from "../brain/SpendFeed.ts";
import { BudgetBook } from "./BudgetBook.ts";
import { BudgetGate } from "./BudgetGateExtension.ts";
import { budgetBootRepair } from "./BudgetGuard.ts";
import { BudgetSources } from "./BudgetSources.ts";
import { SpendHandlers } from "./SpendHandlers.ts";
import { reconcileSpendAtBoot } from "./SpendLedger.ts";
import { UsageFeed } from "./UsageFeed.ts";
import { UsageHandlers } from "./UsageHandlers.ts";

/** What the usage feature registers. */
export const UsageFeature = {
  name: "usage",
  extensionSources: [BudgetGate.useSync((gate) => gate.extension)],
  extensionLayer: BudgetGate.layer.pipe(Layer.provide(BudgetBook.layer)),
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [
    placed(
      RepairOrder.spendReconcile,
      bootRepair("spend reconcile", reconcileSpendAtBoot)
    ),
    placed(
      RepairOrder.budget,
      bootRepair("budget boot repair", budgetBootRepair)
    ),
  ],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: Layer.mergeAll(
    UsageHandlers.pipe(Layer.provide(UsageFeed.layer)),
    SpendHandlers
  ),
  harnessLayer: Layer.mergeAll(SpendFeed.layer, BudgetSources.layer),
  appLayer: Layer.empty,
} satisfies CairnFeature;
