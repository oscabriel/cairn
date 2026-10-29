// J-typed's verdict (`judgeTrial` in judges/fixtures/TypedResults.ts), on transcripts written here:
// the gate is a schema-valid result within two attempts, counted alike by the judge and the tool,
// from the model asked for and dispatched; a wrong fact inside a valid result is reported apart and
// passes (wave 2 decision). Each case that must fail names the one thing that fails it.

import type { ModelRef } from "@cairn/protocol/Models";
import type { JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  NUDGE_TEXT,
  RESULT_TOOL_NAME,
} from "../apps/server/src/models/ResultTool.ts";
import { judgeTrial } from "./fixtures/TypedResults.ts";
import type { TrialReading } from "./fixtures/TypedResults.ts";

const MODEL: ModelRef = { provider: "opencode-go", modelId: "small" };

const GOOD = {
  summary: "parse() is tested on its happy path only.",
  files: [
    { path: "src/parse.ts", lines: 120, role: "source" },
    { path: "src/parse.test.ts", lines: 64, role: "test" },
    { path: "README.md", lines: 30, role: "doc" },
  ],
  evidence: ["No test passes empty input.", "The README names parse() only."],
  confidence: 0.8,
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

const assistant = (model: ModelRef = MODEL): Message => ({
  role: "assistant",
  content: [{ type: "text", text: "Done." }],
  api: "openai-completions",
  provider: model.provider,
  model: model.modelId,
  usage: {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { ...ZERO, total: 0.001 },
  },
  stopReason: "stop",
  timestamp: 0,
});

const user = (text: string): Message => ({
  role: "user",
  content: text,
  timestamp: 0,
});

const submitted = (isError: boolean): Message => ({
  role: "toolResult",
  toolCallId: "call",
  toolName: RESULT_TOOL_NAME,
  content: [{ type: "text", text: isError ? "rejected" : "accepted" }],
  isError,
  timestamp: 0,
});

/** A reading of a child that sent `messages` and stored `result` after `attempts`. */
const reading = (
  messages: ReadonlyArray<Message>,
  result: JsonValue,
  attempts: number,
  dispatched: ModelRef = MODEL
): TrialReading => ({
  messages,
  stored: Option.some({ result, divergence: "None.", attempts }),
  requested: MODEL,
  dispatched: Option.some(dispatched),
});

const firstTry = [user("task"), assistant(), submitted(false), assistant()];

describe("J-typed's verdict", () => {
  it("passes a valid result on the first attempt, facts right", () => {
    const trial = judgeTrial(reading(firstTry, GOOD, 1));

    assert.isTrue(trial.valid);
    assert.isTrue(trial.factsRight);
    assert.strictEqual(trial.attempts, 1);
  });

  it("passes a valid result with a wrong fact, and reports the fact", () => {
    const trial = judgeTrial(
      reading(
        firstTry,
        {
          ...GOOD,
          files: [
            { path: "src/parse.ts", lines: 120, role: "source" },
            { path: "src/parse.test.ts", lines: 64, role: "test" },
            { path: "path/to/README.md", lines: 30, role: "doc" },
          ],
        },
        1
      )
    );

    assert.isTrue(trial.valid);
    assert.isFalse(trial.factsRight);
    assert.match(trial.factsFailure, /^files /u);
  });

  it("passes a second attempt after a rejected one", () => {
    const trial = judgeTrial(
      reading(
        [user("task"), submitted(true), submitted(false), assistant()],
        GOOD,
        2
      )
    );

    assert.isTrue(trial.valid);
    assert.strictEqual(trial.attempts, 2);
  });

  it("counts a nudge before any call as an attempt", () => {
    const trial = judgeTrial(
      reading(
        [user("task"), assistant(), user(NUDGE_TEXT), submitted(false)],
        GOOD,
        2
      )
    );

    assert.isTrue(trial.valid);
    assert.isTrue(trial.nudged);
    assert.strictEqual(trial.attempts, 2);
  });

  it("fails a third attempt", () => {
    const trial = judgeTrial(
      reading(
        [submitted(true), submitted(true), submitted(false), assistant()],
        GOOD,
        3
      )
    );

    assert.isFalse(trial.valid);
    assert.strictEqual(trial.attempts, 3);
  });

  it("fails when the tool's count differs from the transcript's", () => {
    assert.isFalse(judgeTrial(reading(firstTry, GOOD, 2)).valid);
  });

  it("fails a result off the schema", () => {
    const trial = judgeTrial(
      reading(firstTry, { ...GOOD, confidence: "high" }, 1)
    );

    assert.isFalse(trial.valid);
    assert.strictEqual(trial.failure, "schema");
  });

  it("fails evidence sent as one JSON string, which the schema alone lets through", () => {
    const trial = judgeTrial(
      reading(
        firstTry,
        { ...GOOD, evidence: [JSON.stringify(GOOD.evidence)] },
        1
      )
    );

    assert.isFalse(trial.valid);
    assert.match(trial.failure, /^evidence wrapped/u);
  });

  it("fails when nothing was stored", () => {
    const trial = judgeTrial({
      messages: [user("task"), assistant(), user(NUDGE_TEXT), assistant()],
      stored: Option.none(),
      requested: MODEL,
      dispatched: Option.some(MODEL),
    });

    assert.isFalse(trial.valid);
    assert.strictEqual(trial.failure, "none stored");
  });

  it("fails a child dispatched on another model", () => {
    const other: ModelRef = { provider: "opencode-go", modelId: "other" };

    assert.isFalse(judgeTrial(reading(firstTry, GOOD, 1, other)).valid);
  });

  it("fails a result returned by another model", () => {
    const other: ModelRef = { provider: "claude-bridge", modelId: "small" };

    const trial = judgeTrial(
      reading([user("task"), submitted(false), assistant(other)], GOOD, 1)
    );

    assert.isFalse(trial.valid);
    assert.strictEqual(trial.returnedModel, "claude-bridge/small");
  });
});
