// How a failed run failed, from what pi-durable recorded: the run task's error message and the
// settlement reason (`model_error`, `no_model`). A usage limit is told apart from other provider
// errors by its words, one set per plan:
// - the Claude bridge starts its plan-window rejection with "Claude plan quota exceeded"; the reset
//   time comes from the plan window that rejected, so it is left to the usage feed;
// - Codex (pi-ai `openai-codex-responses.ts` `parseErrorResponse`) says "You have hit your ChatGPT
//   usage limit (<plan> plan). Try again in ~<n> min.", and the reset is the failure's time plus
//   those minutes; the Responses API path words a shared-plan limit with its error codes; on the
//   WebSocket transport (Codex's default) an `error` event becomes "Codex error: <server message>",
//   with the code left out when a message is present, so a message that speaks of a usage limit
//   counts too. No real WebSocket limit body has been captured yet: the Codex login judge (1D, 3D)
//   records one and adds it to RunFailure.test.ts;
// - OpenCode Go answers with `GoUsageLimitError` (or `FreeUsageLimitError`), "Monthly usage limit
//   reached" or a request to enable "available balance" (pi-ai `utils/retry.ts`), with no reset.
//
// A run a brain restart ended is told by its reason, not its words (`BRAIN_RESTART_REASONS`):
// pi-durable 1.5 charges a request a crash cut off as a failed attempt and, with no retry left,
// ends the run `interrupted` ("The host stopped while the model was answering, on attempt N"); a
// generation crashes cut off `restartLimit` times ends `restart_limit`.
//
// After a run ends without an answer, pi-durable keeps why in `pi.live.runFailure` until the next
// run starts (spec section 8.2): its reason, the error text in `detail`, and the task that ended it.
// `recordedRunFailureOf` and `classifyRecordedRunFailure` read that record as RunTerminal reads the
// ending task (`CommitFeed.ts` `runEnd`), so the boot reconcile can end a row whose RunTerminal a
// crash lost (server-edges.V5). A run started in the same commit keeps the record (`keepFailure`),
// but only after a reset or a `continue` policy: Cairn keeps queued inputs after a failure
// (`afterFailedRun: "keep"`), so a failure the record holds while no run is live is the newest
// run's.

import type { JsonValue } from "@earendil-works/chord/json";
import type { JsonObject } from "@earendil-works/pi-durable";
import { DateTime, Duration, Option, Predicate } from "effect";

import type { RunFailureInfo, UsageLimitPlan } from "./HarnessSeam.ts";

/** What the Claude bridge's plan-window rejection starts with. */
export const PLAN_QUOTA_PREFIX = "Claude plan quota exceeded";

/** What pi-ai's Codex provider says when a ChatGPT plan's limit rejects a request. */
export const CODEX_LIMIT_TEXT = "You have hit your ChatGPT usage limit";

/**
 * A Codex plan limit: pi-ai's sentence, the WebSocket path's "Codex error:" naming a usage limit, or
 * the error codes the Responses API path passes through.
 */
const CODEX_LIMIT_PATTERN =
  /You have hit your ChatGPT usage limit|^Codex error: .*\busage limit|\busage_limit_reached\b|subscription_sharing_(?:workplace_individual_)?usage_limit_exceeded/iu;

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

/** pi-durable's reasons for a run a brain restart ended (module header). */
const BRAIN_RESTART_REASONS: ReadonlySet<string> = new Set([
  "interrupted",
  "restart_limit",
]);

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
  readonly plan: UsageLimitPlan;
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
 * reset when the text names one), `brain_restart` for a run a brain restart ended (worth sending
 * again), `transport_error` for a network failure, `provider_error` for any other provider or model
 * failure, `unknown` when nothing was recorded.
 */
export const classifyRunFailure = (input: RunFailureInput): RunFailureInfo => {
  const message = input.message.trim();

  if (
    Option.exists(input.reason, (reason) => BRAIN_RESTART_REASONS.has(reason))
  ) {
    return {
      class: "brain_restart",
      retryable: true,
      resetAt: Option.none(),
      plan: Option.none(),
    };
  }

  const limit = usageLimitOf(message, input.at);

  if (Option.isSome(limit)) {
    return {
      class: "usage_limit",
      retryable: false,
      resetAt: limit.value.resetAt,
      plan: Option.some(limit.value.plan),
    };
  }

  if (Option.contains(input.reason, "no_model")) {
    return {
      class: "provider_error",
      retryable: false,
      resetAt: Option.none(),
      plan: Option.none(),
    };
  }

  if (message === "") {
    return {
      class: "unknown",
      retryable: false,
      resetAt: Option.none(),
      plan: Option.none(),
    };
  }

  if (TRANSPORT_PATTERN.test(message)) {
    return {
      class: "transport_error",
      retryable: true,
      resetAt: Option.none(),
      plan: Option.none(),
    };
  }

  return {
    class: "provider_error",
    retryable: !PERMANENT_PATTERN.test(message),
    resetAt: Option.none(),
    plan: Option.none(),
  };
};

/** A failure nothing recorded the cause of. */
export const UNKNOWN_RUN_FAILURE: RunFailureInfo = {
  class: "unknown",
  retryable: false,
  resetAt: Option.none(),
  plan: Option.none(),
};

/** Run ends pi-durable records in `runFailure` that RunTerminal does not report as `failed`. */
const NOT_FAILED_REASONS: ReadonlySet<string> = new Set([
  "reset",
  "turn_limit",
]);

/** What `pi.live.runFailure` names: why the newest run ended without an answer. */
export interface RecordedRunFailure {
  /** pi-durable's `RunFailureReason`; none when the record names none it can read. */
  readonly reason: Option.Option<string>;
  /** The error text, or what was cut off; none when pi-durable wrote none. */
  readonly detail: Option.Option<string>;
}

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

/**
 * The run failure a `pi.live` value records while no run is live, or none. The value is the
 * document as a commit published it or a snapshot read it; none for a missing document.
 */
export const recordedRunFailureOf = (
  live: JsonObject | null | undefined
): Option.Option<RecordedRunFailure> => {
  const failure = live?.runFailure;

  if (live?.run !== undefined || !isObject(failure)) {
    return Option.none();
  }

  return Option.some({
    reason: Option.liftPredicate(failure.reason, Predicate.isString),
    detail: Option.liftPredicate(failure.detail, Predicate.isString),
  });
};

/** Whether RunTerminal reports the recorded run end as `failed` (`classifyRecordedRunFailure`). */
export const reportsFailed = (recorded: RecordedRunFailure): boolean =>
  !(
    Option.exists(recorded.reason, (found) => NOT_FAILED_REASONS.has(found)) ||
    (Option.contains(recorded.reason, "aborted") &&
      Option.isNone(recorded.detail))
  );

/**
 * How RunTerminal reports a recorded run end: none when it reports the end as not failed, the
 * classified failure otherwise. A reset or a turn limit ends the run's task `completed`, and a stop
 * (`aborted` with no detail) ends it `interrupted`; an abort handler cut off too often (`aborted`
 * with a detail) ends its task faulted, which is `failed`. The text classified is the detail, or the
 * reason when pi-durable wrote none (`nothing_to_answer`); a record with neither is `unknown`.
 * `at` is when the run failed.
 */
export const classifyRecordedRunFailure = (
  recorded: RecordedRunFailure,
  at: DateTime.Utc
): Option.Option<RunFailureInfo> => {
  const { reason, detail } = recorded;

  if (!reportsFailed(recorded)) {
    return Option.none();
  }

  return Option.some(
    classifyRunFailure({
      message: Option.getOrElse(
        Option.orElse(detail, () => reason),
        () => ""
      ),
      reason,
      at,
    })
  );
};
