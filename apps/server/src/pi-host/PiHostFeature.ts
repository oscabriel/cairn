// The pi-host feature's manifest (ADR 0053): the tools-only pi host (ADR 0039). Everything it
// registers with the brain and the app is listed here, and `Features.ts` lists this manifest.
//
// `PiHost` is the root's: the user's pi packages in `main.ts`, the empty host everywhere else.

import { Layer } from "effect";

import type { CairnFeature } from "../brain/Feature.ts";
import { PiHost } from "./PiHost.ts";

/** What the pi-host feature registers. */
export const PiHostFeature = {
  name: "pi-host",
  extensionSources: [PiHost.useSync((host) => host.extension)],
  extensionLayer: Layer.empty,
  documents: [],
  answered: [],
  steer: [],
  holdWakes: [],
  bootRepairs: [],
  closeHooks: [],
  reactors: [],
  keptWaits: { kinds: [], tools: [] },
  handlers: Layer.empty,
  harnessLayer: Layer.empty,
  appLayer: Layer.empty,
} satisfies CairnFeature;
