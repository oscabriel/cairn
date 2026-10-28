// How a failed run failed, from what pi-durable recorded: the run task's error message and the
// settlement reason (`model_error`, `no_model`). A usage limit is told apart from other provider
// errors by its words, one set per plan:
// - the Claude bridge starts its plan-window rejection with "Claude plan quota exceeded"; the reset
//   time comes from the plan window that rejected, so it is left to the usage feed;
// - Codex (pi-ai `openai-codex-responses.ts` `parseErrorResponse`) says "You have hit your ChatGPT
//   usage limit (<plan> plan). Try again in ~<n> min.", and the reset is the failure's time plus
//   those minutes; the Responses API path words a shared-plan limit with its error codes;
// - OpenCode Go answers with `GoUsageLimitError` (or `FreeUsageLimitError`), "Monthly usage limit
//   reached" or a request to enable "available balance" (pi-ai `utils/retry.ts`), with no reset.

import { DateTime, Duration, Option } from "effect";

import type { RunFailureInfo } from "./HarnessSeam.ts";

/** What the Claude bridge's plan-window rejection starts with. */
export const PLAN_QUOTA_PREFIX = "Claude plan quota exceeded";

/** What pi-ai's Codex provider says when a ChatGPT plan's limit rejects a request. */
export const CODEX_LIMIT_TEXT = "You have hit your ChatGPT usage limit";

/** A Codex plan limit: pi-ai's sentence, or the error codes the Responses API path passes through. */
const CODEX_LIMIT_PATTERN =
  /You have hit your ChatGPT usage limit|\busage_limit_reached\b|subscription_sharing_(?:workplace_individual_)?usage_limit_exceeded/iu;

/** The wait Codex's sentence names, in whole minutes. */
const CODEX_RESET_PATTERN = /Try again in ~(?<minutes>\d+) min\b/u;

/** An OpenCode Go (or Zen free tier) plan limit, as pi-ai's retry rules name it. */
const GO_LIMIT_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance/iu;

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
  /** When the run failed: a limit that names a wait resets this long after it. */
  readonly at: DateTime.Utc;
}

/** Which plan's limit a failure message names, and when it lifts if the message says. */
export interface UsageLimit {
  readonly plan: "claude" | "codex" | "opencode-go";
  /** None when the message names no wait: the usage feed, or the next success, says when. */
  readonly resetAt: Option.Option<DateTime.Utc>;
}

/** The plan limit a failure message names, if it names one. `at` is when the request failed. */
export const usageLimitOf = (
  message: string,
  at: DateTime.Utc
): Option.Option<UsageLimit> => {
  const text = message.trim();

  if (text.startsWith(PLAN_QUOTA_PREFIX)) {
    return Option.some({ plan: "claude", resetAt: Option.none() });
  }

  if (CODEX_LIMIT_PATTERN.test(text)) {
    const minutes = CODEX_RESET_PATTERN.exec(text)?.groups?.minutes;

    return Option.some({
      plan: "codex",
      resetAt:
        minutes === undefined
          ? Option.none()
          : Option.some(
              DateTime.addDuration(at, Duration.minutes(Number(minutes)))
            ),
    });
  }

  if (GO_LIMIT_PATTERN.test(text)) {
    return Option.some({ plan: "opencode-go", resetAt: Option.none() });
  }

  return Option.none();
};

/**
 * Classifies a failed run: `usage_limit` for a Claude, Codex or OpenCode Go plan limit (with its
 * reset when the text names one), `transport_error` for a network failure, `provider_error` for any
 * other provider or model failure, `unknown` when nothing was recorded.
 */
export const classifyRunFailure = (input: RunFailureInput): RunFailureInfo => {
  const message = input.message.trim();
  const limit = usageLimitOf(message, input.at);

  if (Option.isSome(limit)) {
    return {
      class: "usage_limit",
      retryable: false,
      resetAt: limit.value.resetAt,
    };
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
