// The verdicts feature's manifest (ADR 0053): a thread's goal, its criteria and their judges (ADR
// 0026). Everything it registers with the brain and the app is listed here, and `Features.ts` lists
// this manifest.

import { Effect, Layer } from "effect";

import type { CairnFeature } from "../brain/Feature.ts";
import { ModelSpecs } from "../models/ModelSpecs.ts";
import { GoalBook } from "./GoalBook.ts";
import { GoalDoc } from "./GoalDocs.ts";
import { GoalHandlers } from "./GoalHandlers.ts";
import { Goals } from "./Goals.ts";
import { criteriaAnswered } from "./Verdicts.ts";

/** What the verdicts feature registers. */
export const VerdictsFeature = {
  name: "verdicts",
  extensionSources: [Goals.useSync((goals) => goals.extension)],
  extensionLayer: Goals.layer.pipe(Layer.provide(ModelSpecs.layerNoDeps)),
  documents: [GoalDoc],
  answered: [Effect.succeed(criteriaAnswered)],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: GoalHandlers,
  harnessLayer: GoalBook.layer,
  appLayer: Layer.empty,
} satisfies CairnFeature;
