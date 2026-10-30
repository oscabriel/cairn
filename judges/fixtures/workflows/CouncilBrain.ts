// The judge brain of `judges/council-typed.ts` (workflows note judge 9): a pi-durable Harness over
// an in-memory store with the given extensions and models, its root thread on pi-ai's faux provider
// as the workflow kit's model (`WorkflowTestKit.respond`: it sends `codemode` the script it is
// given and ends). Never the deployed brain or the user's store.
//
// pi-durable and pi-ai are imported here, under `judges/fixtures/` (S42).

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import type { Extension } from "@earendil-works/pi-durable";
import {
  createRegistry,
  Harness,
  MemoryStorage,
} from "@earendil-works/pi-durable";

import {
  KIT_MODEL,
  respond,
} from "../../../apps/server/src/workflows/WorkflowTestKit.ts";
import type { KitBrain } from "../../../apps/server/src/workflows/WorkflowTestKit.ts";

const context = BACKGROUND_CONTEXT;

/** The launching thread's model: the kit's faux model, scripted for a handful of runs. */
export const councilRoot = (): FauxProviderHandle => {
  const root = fauxProvider({
    provider: KIT_MODEL.provider,
    models: [{ id: KIT_MODEL.modelId }],
    tokensPerSecond: 2000,
  });

  root.setResponses(Array.from({ length: 20 }, () => respond));

  return root;
};

/** Opens the brain over `models` with `extensions`, its root thread working in `cwd`. */
export const openCouncilBrain = async (
  models: Models,
  extensions: ReadonlyArray<Extension>,
  cwd: string
): Promise<KitBrain> => {
  const registry = createRegistry();

  for (const extension of extensions) {
    registry.install(extension);
  }

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry },
    context
  );

  const root = await harness.root(context, {
    agent: { model: { ...KIT_MODEL }, cwd },
  });

  return { harness, root: root.id };
};
