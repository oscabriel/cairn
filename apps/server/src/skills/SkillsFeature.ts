// The skills feature's manifest (ADR 0053): the user's skills and the project's context in the
// prompt. Everything it registers with the brain and the app is listed here, and `Features.ts`
// lists this manifest.

import { Layer } from "effect";

import type { CairnFeature } from "../brain/Feature.ts";
import { SkillHandlers } from "./SkillHandlers.ts";
import { skillExtensionSources } from "./SkillsLayer.ts";

/** What the skills feature registers. */
export const SkillsFeature = {
  name: "skills",
  extensionSources: skillExtensionSources,
  extensionLayer: Layer.empty,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: SkillHandlers.layer,
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
