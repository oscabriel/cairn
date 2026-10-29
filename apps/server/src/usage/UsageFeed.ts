// Plan windows for `usage.subscribe`: each frame is every provider's usage, replaced whole. Two
// sources fill it: the Claude bridge (its probe and the `rate_limit_event`s of its turns, merged by
// `ClaudeUsage`) and Codex (ChatGPT's usage endpoint, read by `CodexUsage` with Cairn's Codex
// login). API-key providers have no windows. A subscriber counts as a watcher of each source, which
// keeps its cadence going while a page shows the meter and reads at once when the last reading is
// stale. A source that is off (the bridge disabled, no Codex login) adds no row; with every source
// off the stream says "no providers" once and stays open, so a client never takes the end for a
// failure.

import type { ProviderUsage, UsageSnapshot } from "@cairn/protocol/Usage";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { BridgeProvider } from "../models/BridgeProvider.ts";
import { CodexUsage } from "./CodexUsage.ts";

/** A source with nothing to report: one empty list, then silence. */
const NOTHING: Stream.Stream<ReadonlyArray<ProviderUsage>> = Stream.concat(
  Stream.succeed([]),
  Stream.never
);

/** The usage frames `usage.subscribe` sends. */
export class UsageFeed extends Context.Service<
  UsageFeed,
  {
    /** The current usage at once, then each change; never ends on its own. */
    readonly snapshots: Stream.Stream<UsageSnapshot>;
  }
>()("cairn/server/usage/UsageFeed") {
  /** Over the brain's `BridgeProvider` and a `CodexUsage` the root provides. */
  static readonly layerNoDeps = Layer.effect(
    UsageFeed,
    Effect.gen(function* () {
      const bridge = yield* BridgeProvider;
      const codex = yield* CodexUsage;

      const claudeRows = Option.match(bridge.usage, {
        onNone: () => NOTHING,
        onSome: (usage) => usage.watch,
      });

      // The latest rows of each source, Claude first; a change in either sends a new frame.
      const snapshots = Stream.zipLatestAll(claudeRows, codex.watch).pipe(
        Stream.map(([claude, codexRows]): UsageSnapshot => ({
          providers: [...claude, ...codexRows],
        }))
      );

      return UsageFeed.of({ snapshots });
    })
  );

  /** With its own `CodexUsage` over the global `fetch`. */
  static readonly layer = UsageFeed.layerNoDeps.pipe(
    Layer.provide(CodexUsage.layer)
  );
}
