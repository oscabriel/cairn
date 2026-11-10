// What every test that builds the pi-durable brain shares: the production extension set with its
// test dependencies, and the brain over a temporary data folder on pi-ai's faux model. A dependency
// the extension set gains is added here once, not in each test's stack. Importing the kit in a
// Vitest worker empties the process's pi setup and git environment first (`isolatePiSetup`,
// `isolateGitEnvironment`), so no brain test reads the user's `~/.pi/agent` or an outer thread's
// git hooks. The judge brains under `judges/fixtures/` reach the kit through `PiHostTestKit.ts` and
// the conformance `Targets.ts` and read the real setup on purpose, so outside Vitest (no `VITEST`
// in the environment) it leaves the process alone. Never imported by production code.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Layer } from "effect";

import { ExecutorLink } from "../executor/ExecutorLink.ts";
import { isolateGitEnvironment } from "../git/GitTestKit.ts";
import { ModelHealth } from "../models/ModelHealth.ts";
import { isolatePiSetup } from "../models/PiConfigTestKit.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { SettingsStore } from "../models/SettingsStore.ts";
import { PiHost } from "../pi-host/PiHost.ts";
import { ReachServicesTest } from "../reach/ReachLayer.ts";
import { Subagents } from "../subagents/Subagents.ts";
import { BrainConfig } from "./BrainConfig.ts";
import type { CairnExtension } from "./Extensions.ts";
import { ExtensionSet } from "./ExtensionSet.ts";
import { FauxModels } from "./FauxModels.ts";
import { PiDurableHarness } from "./PiDurableHarness.ts";

if (process.env.VITEST !== undefined) {
  isolatePiSetup();
  isolateGitEnvironment();
}

/** What the faux model is built with (`FauxModels.layer`). */
export type FauxModelOptions = Parameters<typeof FauxModels.layer>[0];

/** The faux model most brain tests stream from: 4,000 tokens a second, no provider retries. */
export const FAUX_MODEL_OPTIONS: FauxModelOptions = {
  tokensPerSecond: 4000,
  settings: { retry: { enabled: false } },
};

/** What a test changes in the extension set's dependencies; everything else is the test default. */
export interface ExtensionOptions<SE, SR, HE, HR> {
  /** Extensions installed after the production set (the conformance tools, a judge's tool). */
  readonly extra?: ReadonlyArray<CairnExtension>;
  /** The subagents extension: `Subagents.layerTest` unless a test plants faults or tunes it. */
  readonly subagents?: Layer.Layer<Subagents, SE, SR>;
  /** The `cairn.pi-tools` host: the empty one unless a test loads pi packages. */
  readonly piHost?: Layer.Layer<PiHost, HE, HR>;
}

/**
 * The production extension set over its test dependencies: Executor disabled, an in-memory model
 * health and settings, the test reach services and the catalog over the ambient `ModelSource`.
 * Leaves `ModelSource` (and what `subagents` or `piHost` need) to the caller. `ModelHealth.layerTest`
 * and `SettingsStore.layerTest` are the references `Subagents.layerTest` uses, so a test that also
 * provides them outside gets the same instance from the memo map.
 */
export const brainExtensions = <SE = never, SR = never, HE = never, HR = never>(
  options: ExtensionOptions<SE, SR, HE, HR> = {}
) => {
  const subagents: Layer.Layer<
    Subagents,
    SE | Layer.Error<typeof Subagents.layerTest>,
    SR | Layer.Services<typeof Subagents.layerTest>
  > = options.subagents ?? Subagents.layerTest;

  const piHost: Layer.Layer<PiHost, HE, HR> =
    options.piHost ?? PiHost.layerEmpty;

  return (
    options.extra === undefined
      ? ExtensionSet.layer
      : ExtensionSet.withExtra(options.extra)
  ).pipe(
    Layer.provide(subagents),
    Layer.provide(ExecutorLink.layerDisabled),
    Layer.provide(piHost),
    Layer.provide(ModelHealth.layerTest),
    Layer.provide(SettingsStore.layerTest),
    Layer.provide(ReachServicesTest),
    Layer.provide(PiModelSource.layerFromModelSource)
  );
};

/** The brain a test builds: `brainExtensions`'s options, the faux model and the data folder. */
export interface TestBrainOptions<SE, SR, HE, HR> extends ExtensionOptions<
  SE,
  SR,
  HE,
  HR
> {
  /** The faux model's options: `FAUX_MODEL_OPTIONS` by default. */
  readonly model?: FauxModelOptions;
  /** Where `brain.sqlite` lives: a new temporary folder by default, made when this is called. */
  readonly dataDir?: string;
}

/**
 * The production seam and brain (`PiDurableHarness.layer`) over `brainExtensions`, the faux model
 * (its `FauxModels` handle provided too, so a test scripts the answers) and `dataDir`. Building it
 * again over the same `dataDir` is the next boot.
 */
export const testBrain = <SE = never, SR = never, HE = never, HR = never>(
  options: TestBrainOptions<SE, SR, HE, HR> = {}
) =>
  PiDurableHarness.layer.pipe(
    Layer.provideMerge(brainExtensions(options)),
    Layer.provideMerge(FauxModels.layer(options.model ?? FAUX_MODEL_OPTIONS)),
    Layer.provide(
      BrainConfig.layerFrom(
        options.dataDir ?? mkdtempSync(path.join(tmpdir(), "cairn-brain-"))
      )
    )
  );
