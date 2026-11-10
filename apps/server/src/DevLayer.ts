// The development brain's harness: the scripted harness (echoing model, in-memory store) behind
// the seam, the dev default (`dev-main.ts`), and the scripted brain judges and tests run the app
// over. A test double: the deployed brain never loads this module (`main.test.ts` walks `main.ts`'s
// imports).

import { Effect, Layer } from "effect";

import { HarnessBoot, withCatalog } from "./AppLayer.ts";
import { EventReactors } from "./brain/EventReactors.ts";
import { FauxModels } from "./brain/FauxModels.ts";
import { ScriptedHarness } from "./brain/ScriptedHarness.ts";
import { SpendFeed } from "./brain/SpendFeed.ts";
import { Skills } from "./skills/SkillsLayer.ts";
import { BudgetSources } from "./usage/BudgetSources.ts";
import { GoalBook } from "./verdicts/GoalBook.ts";
import { WorkflowStops } from "./workflows/WorkflowStop.ts";

/**
 * The scripted harness (echoing model, in-memory store) behind the seam: the dev default. The
 * picker's catalog and the title model see the faux model.
 */
export const ScriptedBrain = Layer.mergeAll(
  Layer.succeed(HarnessBoot, HarnessBoot.of({ resume: Effect.void })),
  EventReactors.layerOff,
  SpendFeed.layerOff,
  BudgetSources.layerNone,
  WorkflowStops.layerOff,
  GoalBook.layerOff
).pipe(
  Layer.provideMerge(ScriptedHarness.layer),
  Layer.provideMerge(Skills.local),
  Layer.provideMerge(
    withCatalog(FauxModels.layer({ tokensPerSecond: 50, settings: {} }))
  )
);
