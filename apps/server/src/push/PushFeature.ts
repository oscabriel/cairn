// The push feature's manifest (ADR 0053): Web Push to the user's devices. Everything it registers
// with the brain and the app is listed here, and `Features.ts` lists this manifest.

import { Layer } from "effect";

import type { CairnFeature } from "../brain/Feature.ts";
import { ExecutorSignInPush } from "./ExecutorSignInPush.ts";
import { PushHandlers } from "./PushHandlers.ts";

/** What the push feature registers. */
export const PushFeature = {
  name: "push",
  extensionSources: [],
  extensionLayer: Layer.empty,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: PushHandlers,
  harnessLayer: Layer.empty,
  appLayer: ExecutorSignInPush,
} satisfies CairnFeature;
