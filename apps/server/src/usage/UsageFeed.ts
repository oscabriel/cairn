// Plan windows for `usage.subscribe`: each frame is every provider's usage, replaced whole. Today
// the only provider with plan windows is the Claude bridge (its probe and the `rate_limit_event`s
// of its turns, merged by `ClaudeUsage`); API-key providers have none. A subscriber counts as a
// watcher of `ClaudeUsage`, which keeps the probe's five-minute cadence going while a page shows
// the meter and probes at once when the last reading is stale. With the bridge off the stream says
// "no providers" once and stays open, so a client never takes the end for a failure.

import type { UsageSnapshot } from "@cairn/protocol/Usage";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { BridgeProvider } from "../models/BridgeProvider.ts";

/** The frame while no provider reports plan windows. */
const NO_PROVIDERS: UsageSnapshot = { providers: [] };

/** The usage frames `usage.subscribe` sends. */
export class UsageFeed extends Context.Service<
  UsageFeed,
  {
    /** The current usage at once, then each change; never ends on its own. */
    readonly snapshots: Stream.Stream<UsageSnapshot>;
  }
>()("cairn/server/usage/UsageFeed") {
  /** Over the brain's `BridgeProvider`. */
  static readonly layer = Layer.effect(
    UsageFeed,
    Effect.gen(function* () {
      const bridge = yield* BridgeProvider;

      const snapshots = Option.match(bridge.usage, {
        onNone: () => Stream.concat(Stream.succeed(NO_PROVIDERS), Stream.never),
        onSome: (usage) =>
          Stream.map(usage.watch, (providers): UsageSnapshot => ({
            providers,
          })),
      });

      return UsageFeed.of({ snapshots });
    })
  );
}
