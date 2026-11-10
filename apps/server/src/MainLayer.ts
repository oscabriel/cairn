// The deployed brain's composition, short of its edges: the app, pi-durable behind the seam over
// the given models, and the brain's shared stores, each given to the app and the brain as the one
// reference its module exports. `main.ts` provides the real edges; `Composition.test.ts` builds
// this same layer with fakes at the edges and checks that every stateful service is built once.
//
// The edges, left in the layer's requirements: the porch, the portal units and their settings, the
// pi tools host, the bridge, the Executor link, the OAuth store, the push and upload keys, the
// identity rules, the server settings and the platform.

import { Layer } from "effect";

import { AppLayer, PiDurableBrain } from "./AppLayer.ts";
import type { ModelSource } from "./brain/ModelSource.ts";
import { ModelHealthLive } from "./models/ModelHealth.ts";
import { SettingsLive } from "./models/SettingsStore.ts";
import { ReachLive } from "./reach/ReachLayer.ts";

/**
 * The deployed composition over `models`, pi's model runtime in `main.ts`. The health store, the
 * settings and the reach services are provided once here, for the app and the brain alike.
 */
export const MainLayer = <Models>(models: Layer.Layer<ModelSource | Models>) =>
  AppLayer.pipe(
    Layer.provide(PiDurableBrain({ models })),
    // The brain's health feed and the login RPCs share one store.
    Layer.provide(ModelHealthLive),
    // The brain's tools and the settings RPCs share one store.
    Layer.provide(SettingsLive),
    // The `cairn.reach` tools and the reach RPCs share one portal store.
    Layer.provide(ReachLive)
  );
