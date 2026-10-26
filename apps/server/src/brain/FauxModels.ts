// The handle of pi-ai's faux provider when the brain runs on scripted models
// (`ModelSource.layerFaux`): tests, judges and the conformance suite script its answers here.

import type { FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { Context } from "effect";

/** The faux provider behind `ModelSource.layerFaux`, for scripting its answers. */
export class FauxModels extends Context.Service<
  FauxModels,
  { readonly faux: FauxProviderHandle }
>()("cairn/server/brain/FauxModels") {}
