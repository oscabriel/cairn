// How a failed run failed, from what pi-durable recorded: the run task's error message and the
// settlement reason (`model_error`, `no_model`). The Claude bridge words a plan-window rejection so
// it starts with "Claude plan quota exceeded" (pi-ai then does not retry it), which is how a usage
// limit is told apart from other provider errors. The reset time of a usage limit comes from the
// plan window that rejected, not from this text, so it is left to the usage feed.

import { Option } from "effect";

import type { RunFailureInfo } from "./HarnessSeam.ts";

/** What the Claude bridge's plan-window rejection starts with. */
export const PLAN_QUOTA_PREFIX = "Claude plan quota exceeded";

/**
 * Network failures between the brain and a provider: worth sending again. A bare `terminated` is
 * undici cutting a body that went quiet past its idle timeout (`spikes/9-http-idle`); only the
 * whole message counts, so a provider answer that uses the word stays a provider error.
 */
const TRANSPORT_PATTERN =
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network error|connection (?:reset|closed|refused)|timed? ?out|^terminated$/iu;

/** Provider answers that will fail the same way again: bad request, auth, unknown model. */
const PERMANENT_PATTERN =
  /\b(?:400|401|403|404|422)\b|invalid[_ ]api[_ ]key|unauthori[sz]ed|not[_ ]found|invalid[_ ]request/iu;

/** What a failed run task recorded. */
export interface RunFailureInput {
  /** The run task's error message, as the provider or pi-durable wrote it. */
  readonly message: string;
  /** pi-durable's settlement reason for the run's inputs, when it gave one. */
  readonly reason: Option.Option<string>;
}

/**
 * Classifies a failed run: `usage_limit` for the bridge's plan-quota text, `transport_error` for a
 * network failure, `provider_error` for any other provider or model failure, `unknown` when nothing
 * was recorded.
 */
export const classifyRunFailure = (input: RunFailureInput): RunFailureInfo => {
  const message = input.message.trim();

  if (message.startsWith(PLAN_QUOTA_PREFIX)) {
    return { class: "usage_limit", retryable: false, resetAt: Option.none() };
  }

  if (Option.contains(input.reason, "no_model")) {
    return {
      class: "provider_error",
      retryable: false,
      resetAt: Option.none(),
    };
  }

  if (message === "") {
    return { class: "unknown", retryable: false, resetAt: Option.none() };
  }

  if (TRANSPORT_PATTERN.test(message)) {
    return {
      class: "transport_error",
      retryable: true,
      resetAt: Option.none(),
    };
  }

  return {
    class: "provider_error",
    retryable: !PERMANENT_PATTERN.test(message),
    resetAt: Option.none(),
  };
};
