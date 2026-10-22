// The extension set the brain installs, in order (integration seam). A later package adds its
// extension by adding its source here at the end of its wave; the order key, not the position in
// this list, decides where it installs.
import { Effect, Layer } from "effect";

import { CodeMode } from "./CodeMode.ts";
import { CodingTools } from "./CodingTools.ts";
import { Extensions } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";

const production: ReadonlyArray<
  Effect.Effect<CairnExtension, never, CodingTools | CodeMode>
> = [
  CodingTools.useSync((tools) => tools.extension),
  CodeMode.useSync((codemode) => codemode.extension),
];

const dependencies = Layer.mergeAll(CodingTools.layer, CodeMode.layer);

/** The installed set: production extensions, plus any a composition root adds (judges). */
export const ExtensionSet = {
  layer: Extensions.fromSources(production).pipe(Layer.provide(dependencies)),
  /** The production set plus `extra`, for `judge-main.ts` and tests. */
  withExtra: (extra: ReadonlyArray<CairnExtension>) =>
    Extensions.fromSources([
      ...production,
      ...extra.map((extension) => Effect.succeed(extension)),
    ]).pipe(Layer.provide(dependencies)),
};
