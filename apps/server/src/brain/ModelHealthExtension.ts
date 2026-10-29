// The `model-health` extension: after each provider response it records one outcome per request
// in `ModelHealth`, so role resolution can pass over a provider that is failing or limited.
//
// pi-durable's `afterResponse` fires for every terminal attempt, before the generation decides
// whether to retry (`classify` in pi-durable's `harness/generation.js`). Recording every attempt
// would count one request whose retries ran out up to its attempt count, and three transient
// failures turn a provider failing. So the hook mirrors the retry decision: an error pi-durable is
// about to retry records nothing, and the request's last attempt (a success, or the error it ends
// on) records its outcome. The decision is pi-durable's own rule: an error that is not a context
// overflow, that pi-ai's `isRetryableAssistantError` takes as transient, with retries enabled and
// the attempt (`pi.live`'s `generation.attempt`) at most `maxRetries`. The policy is read from the
// brain's run settings at each response, as pi-durable reads it.
//
// The extension is installed in every brain, so the set never churns (footgun "moving default
// selections"). The hook runs `ModelHealth.record` through one runtime made from the layer's scope
// (S43), and a failed write is logged, never thrown, so health never breaks a run.

import type { Context as ChordContext } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type { HookApi } from "@earendil-works/pi-durable";
import {
  DEFAULT_RETRY_POLICY,
  defineExtension,
  GenerationTask,
  hook,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { Context, Effect, FiberSet, Layer, Option } from "effect";

import { ModelHealth, outcomeOfResponse } from "../models/ModelHealth.ts";
import { ExtensionOrder } from "./Extensions.ts";
import type { CairnExtension } from "./Extensions.ts";
import { ModelSource } from "./ModelSource.ts";

/** The extension's name in pi-durable's registry. */
export const MODEL_HEALTH_EXTENSION = "cairn.model-health";

/** The retry policy pi-durable applies: the run settings' over its defaults. */
export interface RetryRule {
  readonly enabled: boolean;
  readonly maxRetries: number;
}

/**
 * Whether pi-durable will retry the request `message` ended, at attempt `attempt` (1 for the
 * first): pi-durable's `classify` rule. An overflow is never retried (a compaction may send the
 * request again, but that is a request failure, which never counts).
 */
export const willRetry = (
  message: AssistantMessage,
  attempt: number,
  rule: RetryRule
): boolean =>
  message.stopReason === "error" &&
  !isContextOverflow(message) &&
  isRetryableAssistantError(message) &&
  rule.enabled &&
  attempt <= rule.maxRetries;

/**
 * The attempt the conversation's generation is on, from `pi.live`. None when no attempt is
 * recorded, which the hook treats as a last attempt: a failure counted twice is better than one
 * never counted.
 */
const attemptOf = async (
  api: HookApi,
  context: ChordContext
): Promise<Option.Option<number>> => {
  const live = await api.snapshot(LiveDoc, api.conversationId, context);

  return Option.fromUndefinedOr(live?.generation?.attempt);
};

/** The `model-health` extension. */
export class ModelHealthFeed extends Context.Service<
  ModelHealthFeed,
  {
    /** The extension, for the installed set. */
    readonly extension: CairnExtension;
  }
>()("cairn/server/brain/ModelHealthExtension/ModelHealthFeed") {
  /** Over the brain's `ModelHealth` and its run settings (`ModelSource`). */
  static readonly layer = Layer.effect(
    ModelHealthFeed,
    Effect.gen(function* () {
      const health = yield* ModelHealth;
      const source = yield* ModelSource;
      const run = yield* FiberSet.makeRuntimePromise();

      const recordResponse = Effect.fn("ModelHealthFeed.recordResponse")(
        function* (message: AssistantMessage) {
          for (const [provider, outcome] of Option.toArray(
            outcomeOfResponse(message)
          )) {
            yield* health.record(provider, outcome).pipe(
              Effect.catchTag("ModelHealthError", (failure) =>
                Effect.logWarning("model health not recorded").pipe(
                  Effect.annotateLogs({
                    event: "model_health_record_failed",
                    provider,
                    cause: failure.message,
                  })
                )
              )
            );
          }
        }
      );

      const extension = defineExtension({
        name: MODEL_HEALTH_EXTENSION,
        hooks: [
          hook(GenerationTask, {
            afterResponse: async (message, api, context) => {
              if (message.stopReason === "error") {
                const attempt = await attemptOf(api, context);
                const { retry } = source.settings();

                const rule: RetryRule = {
                  enabled: retry?.enabled ?? DEFAULT_RETRY_POLICY.enabled,
                  maxRetries:
                    retry?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
                };

                if (
                  Option.isSome(attempt) &&
                  willRetry(message, attempt.value, rule)
                ) {
                  return;
                }
              }

              await run(recordResponse(message));
            },
          }),
        ],
      });

      return ModelHealthFeed.of({
        extension: { order: ExtensionOrder.modelHealth, extension },
      });
    })
  );
}
