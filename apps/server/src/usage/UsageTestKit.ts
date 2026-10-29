// Test doubles for the usage feed's tests: a `PiModelSource` that lists given provider statuses and
// nothing else, for the feed's OpenCode Go row.

import type { ProviderStatus } from "@cairn/protocol/Models";
import { Effect, Layer, Option } from "effect";

import { PiModelSource } from "../models/PiModelSource.ts";

/** OpenCode Go signed in, as `PiModelSource.providers` reports it. */
export const OPENCODE_GO_READY: ProviderStatus = {
  provider: "opencode-go",
  name: "OpenCode Go",
  credential: "api-key",
  state: "ready",
  detail: Option.none(),
};

/** A `PiModelSource` whose `providers` are `statuses`; its catalog is not used by these tests. */
export const providersOf = (statuses: ReadonlyArray<ProviderStatus>) =>
  Layer.succeed(
    PiModelSource,
    PiModelSource.of({
      catalog: () => Effect.die("not used by this test"),
      providers: Effect.succeed(statuses),
    })
  );
