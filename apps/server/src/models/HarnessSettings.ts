// The brain's run settings, taken from pi's own `settings.json` so the TUI and Cairn agree: the
// compaction thresholds and per-model overrides, the retry policy, the provider request retries and
// timeout, steering and follow-up modes, and the transport. Two Cairn choices sit on top:
//
// - a failed run keeps the inputs queued behind it (`afterFailedRun: keep`, plan D17), shown as
//   "queued, will run when you send again", instead of sending them silently;
// - every `claude-bridge` model gets a compaction override (plan D7): background compaction off
//   (`backgroundTokens: 0`) and a small reserve (16,384 tokens), so blocking compaction, which opens
//   a fresh Claude session, is rare. Blocking and overflow compaction stay enabled.
//
// Read at each use: pi-durable calls the getter on every resolution, so a settings change reaches
// the next request once `PiConfig` has refreshed.

import { Context, Effect, Layer, Option } from "effect";

import type { ModelSource } from "../brain/ModelSource.ts";
import { BASE_HARNESS_SETTINGS } from "../brain/ModelSource.ts";
import type { PiRunSettings } from "./PiConfig.ts";
import { PiConfig } from "./PiConfig.ts";

/** pi-durable's `HarnessSettings`, as the model source hands it over. */
export type DurableSettings = ReturnType<ModelSource["Service"]["settings"]>;

type CompactionOverride = NonNullable<
  NonNullable<DurableSettings["compaction"]>["modelOverrides"]
>[string];

/** The bridge provider's id. */
export const BRIDGE_PROVIDER = "claude-bridge";

/** D7: the compaction override every bridge model gets. */
export const BRIDGE_COMPACTION: CompactionOverride = {
  backgroundTokens: 0,
  reserveTokens: 16_384,
};

/**
 * pi's run settings as pi-durable settings, with Cairn's `afterFailedRun: keep` and D7's override
 * for each bridge model id (`claude-bridge/<id>`, winning over pi's own override for that key).
 */
export const harnessSettingsFrom = (
  run: PiRunSettings,
  bridgeModelIds: ReadonlyArray<string>
): DurableSettings => {
  const modelOverrides: Record<string, CompactionOverride> = {};

  for (const [key, override] of run.compaction.modelOverrides) {
    modelOverrides[key] = {
      ...Option.match(override.reserveTokens, {
        onNone: () => ({}),
        onSome: (reserveTokens) => ({ reserveTokens }),
      }),
      ...Option.match(override.keepRecentTokens, {
        onNone: () => ({}),
        onSome: (keepRecentTokens) => ({ keepRecentTokens }),
      }),
    };
  }

  for (const id of bridgeModelIds) {
    const key = `${BRIDGE_PROVIDER}/${id}`;

    modelOverrides[key] = { ...modelOverrides[key], ...BRIDGE_COMPACTION };
  }

  const { providerRetry } = run;

  return {
    ...BASE_HARNESS_SETTINGS,
    stream: {
      transport: run.transport,
      maxRetryDelayMs: providerRetry.maxRetryDelayMs,
      ...Option.match(providerRetry.timeoutMs, {
        onNone: () => ({}),
        onSome: (timeoutMs) => ({ timeoutMs }),
      }),
      ...Option.match(providerRetry.maxRetries, {
        onNone: () => ({}),
        onSome: (maxRetries) => ({ maxRetries }),
      }),
    },
    retry: {
      enabled: run.retry.enabled,
      maxRetries: run.retry.maxRetries,
      baseDelayMs: run.retry.baseDelayMs,
      maxAgentDelayMs: run.retry.maxAgentDelayMs,
    },
    compaction: {
      enabled: run.compaction.enabled,
      reserveTokens: run.compaction.reserveTokens,
      keepRecentTokens: run.compaction.keepRecentTokens,
      modelOverrides,
    },
    steeringMode: run.steeringMode,
    followUpMode: run.followUpMode,
    afterFailedRun: "keep",
  };
};

/** The brain's run settings, from pi's settings.json as `PiConfig` last read it. */
export class HarnessSettings extends Context.Service<
  HarnessSettings,
  {
    /**
     * The settings for a runtime whose bridge offers `bridgeModelIds`. Synchronous: pi-durable reads
     * it on the Session line.
     */
    settings(bridgeModelIds: ReadonlyArray<string>): DurableSettings;
  }
>()("cairn/server/models/HarnessSettings") {
  /** Over `PiConfig`'s current snapshot. */
  static readonly layerNoDeps = Layer.effect(
    HarnessSettings,
    Effect.gen(function* () {
      const pi = yield* PiConfig;

      return HarnessSettings.of({
        settings: (bridgeModelIds) =>
          harnessSettingsFrom(pi.current().run, bridgeModelIds),
      });
    })
  );

  /** Over the brain's `PiConfig`. */
  static readonly layer = HarnessSettings.layerNoDeps.pipe(
    Layer.provide(PiConfig.layer)
  );
}
