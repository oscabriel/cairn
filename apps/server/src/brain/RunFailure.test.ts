import {
  fauxAssistantMessage,
  isRetryableAssistantError,
} from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  classifyRunFailure,
  CODEX_LIMIT_TEXT,
  PLAN_QUOTA_PREFIX,
  usageLimitOf,
} from "./RunFailure.ts";

const AT = DateTime.makeUnsafe("2026-10-28T12:00:00Z");

const classify = (message: string, reason?: string) =>
  classifyRunFailure({
    message,
    reason: Option.fromUndefinedOr(reason),
    at: AT,
  });

/** The plan whose limit `message` names. */
const plan = (message: string) =>
  Option.map(usageLimitOf(message, AT), (limit) => limit.plan);

/** Whether pi-ai would send a request again after an error answer with `errorMessage`. */
const retried = (errorMessage: string) =>
  isRetryableAssistantError(
    fauxAssistantMessage("", { stopReason: "error", errorMessage })
  );

describe("run failure classes", () => {
  it("maps the bridge's plan-quota text to a usage limit that is not retried", () => {
    const failure = classify(
      `${PLAN_QUOTA_PREFIX}: the five hour window resets at 14:00.`,
      "model_error"
    );

    assert.strictEqual(failure.class, "usage_limit");
    assert.isFalse(failure.retryable);
  });

  it("does not take the prefix anywhere but the start", () => {
    const failure = classify(
      `Upstream said: ${PLAN_QUOTA_PREFIX}`,
      "model_error"
    );

    assert.strictEqual(failure.class, "provider_error");
  });

  it("tells network failures from provider answers", () => {
    assert.strictEqual(
      classify("fetch failed: ECONNRESET", "model_error").class,
      "transport_error"
    );
    assert.isTrue(classify("socket hang up", "model_error").retryable);
  });

  it("takes undici's bare `terminated` as a stream cut, but not the word inside a provider answer", () => {
    // undici ends a body that went quiet past its idle timeout with exactly this (spike 9).
    assert.strictEqual(
      classify("terminated", "model_error").class,
      "transport_error"
    );
    assert.strictEqual(
      classify("Request terminated by content policy", "model_error").class,
      "provider_error"
    );
  });

  it("marks permanent provider errors as not worth sending again", () => {
    const overloaded = classify("529 overloaded_error", "model_error");
    const unauthorized = classify("401 invalid api key", "model_error");

    assert.strictEqual(overloaded.class, "provider_error");
    assert.isTrue(overloaded.retryable);
    assert.strictEqual(unauthorized.class, "provider_error");
    assert.isFalse(unauthorized.retryable);
  });

  it("treats a run without a model as a provider error and an empty one as unknown", () => {
    assert.strictEqual(
      classify("No model configured", "no_model").class,
      "provider_error"
    );
    assert.strictEqual(classify("  ").class, "unknown");
  });

  it("maps Codex's usage-limit sentence to a usage limit that resets after the minutes it names", () => {
    // Worded by pi-ai's `parseErrorResponse` in `openai-codex-responses.ts`.
    const failure = classify(
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~95 min.",
      "model_error"
    );

    assert.strictEqual(failure.class, "usage_limit");
    assert.isFalse(failure.retryable);
    assert.deepStrictEqual(
      failure.resetAt,
      Option.some(DateTime.makeUnsafe("2026-10-28T13:35:00Z"))
    );
  });

  it("takes a Codex limit with no wait as a limit with no reset", () => {
    const failure = classify(`${CODEX_LIMIT_TEXT}.`, "model_error");

    assert.strictEqual(failure.class, "usage_limit");
    assert.isTrue(Option.isNone(failure.resetAt));
  });

  it("takes the Responses API's shared-plan limit codes as a Codex usage limit", () => {
    for (const message of [
      'openai-codex API error (429): {"error":{"code":"usage_limit_reached"}}',
      "429 subscription_sharing_usage_limit_exceeded\nCheck your ChatGPT usage: https://chatgpt.com/codex/settings/usage",
      "429 subscription_sharing_workplace_individual_usage_limit_exceeded",
    ]) {
      const failure = classify(message, "model_error");

      assert.strictEqual(failure.class, "usage_limit", message);
      assert.isFalse(failure.retryable, message);
    }
  });

  it("maps OpenCode Go's limit errors to a usage limit with no reset", () => {
    for (const message of [
      '429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Rolling usage limit reached"}}',
      "429 FreeUsageLimitError: free tier exhausted",
      "Monthly usage limit reached. Enable available balance to keep going.",
      "Usage limit reached; turn on usage from your available balance",
    ]) {
      const failure = classify(message, "model_error");

      assert.strictEqual(failure.class, "usage_limit", message);
      assert.isFalse(failure.retryable, message);
      assert.isTrue(Option.isNone(failure.resetAt), message);
    }
  });

  it("names the plan whose limit was hit", () => {
    assert.deepStrictEqual(
      plan(`${PLAN_QUOTA_PREFIX}: weekly`),
      Option.some("claude")
    );
    assert.deepStrictEqual(
      plan(`${CODEX_LIMIT_TEXT}. Try again in ~3 min.`),
      Option.some("codex")
    );
    assert.deepStrictEqual(
      plan("GoUsageLimitError"),
      Option.some("opencode-go")
    );
    assert.deepStrictEqual(plan("429 rate limit, slow down"), Option.none());
  });

  it("keeps a transient 429 a retryable provider error, not a usage limit", () => {
    const failure = classify("429 Too Many Requests", "model_error");

    assert.strictEqual(failure.class, "provider_error");
    assert.isTrue(failure.retryable);
  });

  it("agrees with pi-ai's retry rule on the limit texts pi-ai words itself", () => {
    // pi-ai retries an assistant error before the run fails; a limit it retried would only cost
    // backoff, but the texts its own providers write must reach the run as they are.
    for (const message of [
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~95 min.",
      '429 {"type":"error","error":{"type":"GoUsageLimitError"}}',
      "Monthly usage limit reached",
      `${PLAN_QUOTA_PREFIX}: the weekly window resets Friday.`,
    ]) {
      assert.isFalse(retried(message), message);
      assert.strictEqual(classify(message, "model_error").class, "usage_limit");
    }

    // A raw `usage_limit_reached` body with its 429 is retried by pi-ai first, then classified.
    const raw =
      'openai-codex API error (429): {"error":{"code":"usage_limit_reached"}}';

    assert.isTrue(retried(raw));
    assert.strictEqual(classify(raw, "model_error").class, "usage_limit");
  });
});
