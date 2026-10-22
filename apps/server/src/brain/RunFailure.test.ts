import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { classifyRunFailure, PLAN_QUOTA_PREFIX } from "./RunFailure.ts";

const classify = (message: string, reason?: string) =>
  classifyRunFailure({ message, reason: Option.fromUndefinedOr(reason) });

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
});
