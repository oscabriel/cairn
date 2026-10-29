// Plan windows for `usage.subscribe`: each frame is every provider's usage, replaced whole. Three
// sources fill it: the Claude bridge (its probe and the `rate_limit_event`s of its turns, merged by
// `ClaudeUsage`), Codex (ChatGPT's usage endpoint, read by `CodexUsage` with Cairn's Codex login),
// and OpenCode Go, a plan with no windows to read: while it is ready its row says `unsupported`, as
// the protocol and the glossary say (the models note's M7 says `unreadable`; the protocol wins, since
// nothing failed). Its readiness is read once per subscriber. API-key providers have no windows.
// A subscriber counts as a watcher of each source, which keeps its cadence going while a page shows
// the meter and reads at once when the last reading is stale. A source that is off (the bridge
// disabled, no Codex login) adds no row; with every source off the stream says "no providers" once
// and stays open, so a client never takes the end for a failure.

import type { ProviderUsage, UsageSnapshot } from "@cairn/protocol/Usage";
import { Context, Effect, Layer, Option, Stream } from "effect";

import { BridgeProvider } from "../models/BridgeProvider.ts";
import { CodexAccess } from "../models/CodexAccess.ts";
import { PiModelSource } from "../models/PiModelSource.ts";
import { CodexSignals } from "./CodexSignals.ts";
import { CodexUsage } from "./CodexUsage.ts";

/** A source with nothing to report: one empty list, then silence. */
const NOTHING: Stream.Stream<ReadonlyArray<ProviderUsage>> = Stream.concat(
  Stream.succeed([]),
  Stream.never
);

/** OpenCode Go's provider id in pi's catalog. */
export const OPENCODE_GO_PROVIDER = "opencode-go";

/** OpenCode Go's row: a plan, but none of its windows can be read. */
const OPENCODE_GO_ROW: ProviderUsage = {
  provider: OPENCODE_GO_PROVIDER,
  reading: "unsupported",
  windows: [],
  checkedAt: Option.none(),
};

/** The usage frames `usage.subscribe` sends. */
export class UsageFeed extends Context.Service<
  UsageFeed,
  {
    /** The current usage at once, then each change; never ends on its own. */
    readonly snapshots: Stream.Stream<UsageSnapshot>;
  }
>()("cairn/server/usage/UsageFeed") {
  /** Over the brain's `BridgeProvider`, its `PiModelSource`, and a `CodexUsage` the root provides. */
  static readonly layerNoDeps = Layer.effect(
    UsageFeed,
    Effect.gen(function* () {
      const bridge = yield* BridgeProvider;
      const codex = yield* CodexUsage;
      const models = yield* PiModelSource;

      const claudeRows = Option.match(bridge.usage, {
        onNone: () => NOTHING,
        onSome: (usage) => usage.watch,
      });

      // A catalog that cannot be read adds no row rather than failing the feed.
      const openCodeRows = Stream.concat(
        Stream.fromEffect(
          models.providers.pipe(
            Effect.map((statuses) =>
              statuses.some(
                (status) =>
                  status.provider === OPENCODE_GO_PROVIDER &&
                  status.state === "ready"
              )
                ? [OPENCODE_GO_ROW]
                : []
            ),
            Effect.orElseSucceed((): ReadonlyArray<ProviderUsage> => [])
          )
        ),
        Stream.never
      );

      // The latest rows of each source, Claude, Codex, then OpenCode Go; a change in one sends a
      // new frame.
      const snapshots = Stream.zipLatestAll(
        claudeRows,
        codex.watch,
        openCodeRows
      ).pipe(
        Stream.map(([claude, codexRows, openCode]): UsageSnapshot => ({
          providers: [...claude, ...codexRows, ...openCode],
        }))
      );

      return UsageFeed.of({ snapshots });
    })
  );

  /**
   * The deployed feed over one `CodexUsage.layer`, which `CodexSignals` feeds too, so a refused
   * Codex turn marks the window this feed shows; the Codex login is read when the brain holds one
   * (`CodexAccess.layerIfHeld`; judge and dev brains, which provide no `OAuthStore`, are signed
   * out). Needs `BridgeProvider`, `PiModelSource` and the `HarnessSeam`.
   */
  static readonly layer = Layer.merge(UsageFeed.layerNoDeps, CodexSignals).pipe(
    Layer.provide(CodexUsage.layer.pipe(Layer.provide(CodexAccess.layerIfHeld)))
  );
}
