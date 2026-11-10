// Where the brain's models and run settings come from. The production layer (pi's model runtime,
// read-only over `~/.pi/agent`, with the Claude bridge registered) is built in `models/`; this module
// owns the service. The faux layer, pi-ai's scripted provider for tests, judges and the dev server,
// is `FauxModels.layer`, in its own file. Both are read at each use, so a credential or settings
// change needs no reopen.

import type { ModelRef } from "@cairn/protocol/Models";
import type {
  AssistantMessage,
  Context as ModelContext,
  Models,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { HarnessSettings } from "@earendil-works/pi-durable";
import type { Effect } from "effect";
import { Context, Schema } from "effect";

/** A direct model call (a title, a branch name) failed. */
export class ModelCallError extends Schema.TaggedError<ModelCallError>()(
  "ModelCallError",
  {
    message: Schema.String,
    provider: Schema.String,
    modelId: Schema.String,
    reason: Schema.Literals(["unknown_model", "request_failed"]),
  }
) {}

/**
 * Run settings every Cairn harness starts from (plan D17): a failed run leaves the inputs queued
 * behind it, shown as "queued, will run when you send again", instead of sending them silently.
 */
export const BASE_HARNESS_SETTINGS: HarnessSettings = {
  afterFailedRun: "keep",
};

/** The brain's models and run settings. */
export class ModelSource extends Context.Service<
  ModelSource,
  {
    /** The current models, read by pi-durable at each use. */
    models(): Models;
    /** The current run settings, read by pi-durable at each use. Synchronous: some readers hold the Session line. */
    settings(): HarnessSettings;
    /** One request outside any conversation, for small jobs such as a title. */
    completeSimple(
      model: ModelRef,
      context: ModelContext,
      options: SimpleStreamOptions
    ): Effect.Effect<AssistantMessage, ModelCallError>;
  }
>()("cairn/server/brain/ModelSource") {}
