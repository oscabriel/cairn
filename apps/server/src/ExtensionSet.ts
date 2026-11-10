// The extension set the brain installs: the brain's own extensions (the coding tools and code
// mode) and every feature's, folded from `Features.ts`, with what the features give the harness
// beside them (the thread stream's documents, an answer's hooks, a submit's and a Stop all's). The
// order key, not the position in a list, decides where an extension installs.
//
// What a feature's extensions read and the feature does not build itself is left to the root:
// the Executor link, the pi tools host, the subagents' service over the app's child workspaces,
// the health and settings stores (`ModelHealthLive`, `SettingsLive`), the reach services
// (`ReachLive`) and the bridge. Each is the one reference its module exports, so the memo map
// builds one for the brain and the app alike (`Composition.test.ts`).

import { Effect, Layer } from "effect";

import { CodeMode } from "./brain/CodeMode.ts";
import { CodingTools } from "./brain/CodingTools.ts";
import { Extensions } from "./brain/Extensions.ts";
import type { CairnExtension, FeatureHooks } from "./brain/Extensions.ts";
import type { Registered } from "./brain/Feature.ts";
import { FEATURES } from "./Features.ts";
import type { Feature } from "./Features.ts";
import { GitVersionLive } from "./git/GitVersionLive.ts";

/** Every feature's extension sources. */
export const extensionSourcesOf = (features: ReadonlyArray<Feature>) =>
  features.flatMap(
    (feature): ReadonlyArray<Registered<Feature, "extensionSources">> =>
      feature.extensionSources
  );

/** Every feature's own extension services. */
export const extensionLayersOf = (features: ReadonlyArray<Feature>) =>
  features.map((feature) => feature.extensionLayer);

/** What the features give the harness, each kind in list order. */
export const featureHooksOf = (
  features: ReadonlyArray<Feature>
): FeatureHooks<Effect.Services<Registered<Feature, "answered">>> => ({
  documents: features.flatMap(
    (feature): FeatureHooks<never>["documents"] => feature.documents
  ),
  answered: features.flatMap(
    (feature): ReadonlyArray<Registered<Feature, "answered">> =>
      feature.answered
  ),
  steer: features.flatMap((feature) => feature.steer),
  holdWakes: features.flatMap((feature) => feature.holdWakes),
});

const sources = [
  CodingTools.useSync((tools) => tools.extension),
  CodeMode.useSync((codemode) => codemode.extension),
  ...extensionSourcesOf(FEATURES),
];

const hooks = featureHooksOf(FEATURES);

// What the sources read, across every feature: TypeScript infers a union of effects' requirements
// from the first member only, so the set names it.
type SourceServices = Effect.Services<(typeof sources)[number]>;

const dependencies = Layer.mergeAll(
  CodingTools.layerNoDeps.pipe(Layer.provide(GitVersionLive)),
  CodeMode.layer,
  ...extensionLayersOf(FEATURES)
);

/** The installed set: every feature's, plus any a composition root adds (judges). */
export const ExtensionSet = {
  layer: Extensions.fromFeatures<never, SourceServices, never>(
    sources,
    hooks
  ).pipe(Layer.provide(dependencies)),
  /** The production set plus `extra`, for `judge-main.ts` and tests. */
  withExtra: (extra: ReadonlyArray<CairnExtension>) =>
    Extensions.fromFeatures<never, SourceServices, never>(
      [...sources, ...extra.map((extension) => Effect.succeed(extension))],
      hooks
    ).pipe(Layer.provide(dependencies)),
};
