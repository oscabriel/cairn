// J-validator: the result tool's repair, validation, schema checks and attempt rules as pure
// functions, the offline table of docs/phase-2/notes/models.md ("Typed results") kept as a test.
// The tool and its hook under a pi-durable Harness are judged in
// `brain/ResultToolHarness.test.ts`.

import type { JsonObject } from "@cairn/protocol/Policy";
import type { Message, Tool } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { assert, describe, it } from "@effect/vitest";
import { Result } from "effect";
import type { Schema } from "effect";

import {
  attemptStateOf,
  canSubmit,
  checkResultSchema,
  declareSchema,
  MAX_SCHEMA_BYTES,
  nudgeDue,
  RESULT_TOOL,
  RESULT_TOOL_NAME,
  validateResult,
} from "./ResultTool.ts";
import type { ResultMark } from "./ResultTool.ts";

/** The probe task's schema: a flat result with an array of objects, a string array and a range. */
const REPORT: JsonObject = {
  type: "object",
  properties: {
    summary: { type: "string" },
    files: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          lines: { type: "integer", minimum: 1 },
          role: { type: "string", enum: ["source", "test", "doc"] },
        },
        required: ["path", "lines", "role"],
        additionalProperties: false,
      },
    },
    evidence: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string" },
  },
  required: ["summary", "files", "evidence", "confidence"],
  additionalProperties: false,
};

const FILES = [
  { path: "src/a.ts", lines: 40, role: "source" },
  { path: "src/a.test.ts", lines: 12, role: "test" },
];

const EVIDENCE = ["pnpm check passed", "two files read"];

const valid = {
  summary: "Read the module.",
  files: FILES,
  evidence: EVIDENCE,
  confidence: 0.8,
};

const accepted = (args: Schema.Json) => {
  const verdict = validateResult(REPORT, args);

  assert.isTrue(
    Result.isSuccess(verdict),
    Result.isFailure(verdict) ? verdict.failure : ""
  );

  return Result.isSuccess(verdict) ? verdict.success : undefined;
};

const rejected = (args: Schema.Json) => {
  const verdict = validateResult(REPORT, args);

  assert.isTrue(Result.isFailure(verdict), "expected a rejection");

  return Result.isFailure(verdict) ? verdict.failure : "";
};

describe("validateResult (J-validator)", () => {
  it("accepts a valid result and its divergence", () => {
    const value = accepted({ result: valid, divergence: "None" });

    assert.deepStrictEqual(value, { result: valid, divergence: "None" });
  });

  it('coerces "4" for an integer and drops null for an optional field', () => {
    const value = accepted({
      result: {
        ...valid,
        files: [{ path: "a", lines: "4", role: "doc" }],
        note: null,
      },
      divergence: "None",
    });

    assert.deepStrictEqual(value?.result, {
      ...valid,
      files: [{ path: "a", lines: 4, role: "doc" }],
    });
  });

  it("parses an array of objects sent as a JSON string", () => {
    const value = accepted({
      result: { ...valid, files: JSON.stringify(FILES) },
      divergence: "None",
    });

    assert.deepStrictEqual(value?.result, valid);
  });

  it("parses a string array sent as a JSON string, instead of wrapping it", () => {
    const value = accepted({
      result: { ...valid, evidence: JSON.stringify(EVIDENCE) },
      divergence: "None",
    });

    assert.deepStrictEqual(value?.result, valid);
  });

  it("parses a result sent as one JSON string", () => {
    const value = accepted({
      result: JSON.stringify(valid),
      divergence: "None",
    });

    assert.deepStrictEqual(value?.result, valid);
  });

  it("moves a result sent at the top level under result", () => {
    const value = accepted({ ...valid, divergence: "None" });

    assert.deepStrictEqual(value, { result: valid, divergence: "None" });
  });

  it("leaves a string that is not JSON for validation to report", () => {
    const errors = rejected({
      result: { ...valid, files: "two files" },
      divergence: "None",
    });

    assert.include(errors, "result.files");
  });

  it("rejects an extra key in the result and in the envelope", () => {
    assert.include(
      rejected({ result: { ...valid, extra: 1 }, divergence: "None" }),
      "result"
    );
    assert.include(
      rejected({ result: valid, divergence: "None", extra: 1 }),
      "additional"
    );
  });

  it("rejects a missing field, a bad enum and an out-of-range number with their paths", () => {
    const { summary: _summary, ...noSummary } = valid;

    assert.include(
      rejected({ result: noSummary, divergence: "None" }),
      "result.summary"
    );
    assert.include(
      rejected({
        result: { ...valid, files: [{ path: "a", lines: 1, role: "other" }] },
        divergence: "None",
      }),
      "result.files.0.role"
    );
    assert.include(
      rejected({ result: { ...valid, confidence: 3 }, divergence: "None" }),
      "result.confidence"
    );
  });

  it("requires a divergence", () => {
    assert.include(rejected({ result: valid }), "divergence");
  });

  it("drops the echo of the arguments from the error text", () => {
    const errors = rejected({
      result: { ...valid, confidence: 3 },
      divergence: "None",
    });

    assert.notInclude(errors, "Received arguments");
    assert.isTrue(errors.split("\n").every((line) => line.startsWith("  - ")));
  });

  it("parses a whole call sent as a JSON string before validation", () => {
    const prepared = RESULT_TOOL.prepareArguments?.(
      JSON.stringify({ result: valid, divergence: "None" })
    );

    assert.deepStrictEqual(prepared, { result: valid, divergence: "None" });
  });
});

const reasonOf = (schema: JsonObject) => {
  const checked = checkResultSchema(schema);

  return Result.isFailure(checked) ? checked.failure.reason : "accepted";
};

describe(checkResultSchema, () => {
  it("accepts the probe schema", () => {
    assert.strictEqual(reasonOf(REPORT), "accepted");
  });

  it("refuses a union at the root", () => {
    assert.strictEqual(
      reasonOf({ anyOf: [{ type: "string" }, { type: "object" }] }),
      "root-union"
    );
    assert.strictEqual(reasonOf({ type: ["string", "number"] }), "root-union");
  });

  it("refuses a schema nested too deep", () => {
    let schema: JsonObject = { type: "string" };

    for (let level = 0; level < 9; level += 1) {
      schema = { type: "array", items: schema };
    }

    assert.strictEqual(reasonOf(schema), "too-deep");
  });

  it("refuses a schema too large", () => {
    assert.strictEqual(
      reasonOf({ type: "string", description: "x".repeat(MAX_SCHEMA_BYTES) }),
      "too-large"
    );
  });

  it("refuses a schema the validator cannot compile", () => {
    assert.strictEqual(
      reasonOf({ type: "string", pattern: "(" }),
      "not-compilable"
    );
  });
});

const state = (...marks: Array<ResultMark>) => attemptStateOf(marks);

describe("attempts", () => {
  it("counts rejected calls up to the first accepted one", () => {
    assert.deepStrictEqual(state("rejected", "accepted", "rejected"), {
      used: 2,
      accepted: true,
      nudged: false,
    });
  });

  it("counts a nudge before any call as the first attempt", () => {
    assert.deepStrictEqual(state("nudge"), {
      used: 1,
      accepted: false,
      nudged: true,
    });
    assert.deepStrictEqual(state("nudge", "accepted"), {
      used: 2,
      accepted: true,
      nudged: true,
    });
  });

  it("does not count a nudge after a call", () => {
    assert.strictEqual(state("rejected", "nudge").used, 1);
  });

  it("allows two attempts, then refuses", () => {
    assert.isTrue(canSubmit(state()));
    assert.isTrue(canSubmit(state("rejected")));
    assert.isFalse(canSubmit(state("rejected", "rejected")));
    assert.isFalse(canSubmit(state("nudge", "rejected")));
    assert.isFalse(canSubmit(state("accepted")));
  });

  it("nudges once, only with an attempt left and no result", () => {
    assert.isTrue(nudgeDue(state()));
    assert.isTrue(nudgeDue(state("rejected")));
    assert.isFalse(nudgeDue(state("nudge")));
    assert.isFalse(nudgeDue(state("rejected", "rejected")));
    assert.isFalse(nudgeDue(state("accepted")));
  });
});

describe(declareSchema, () => {
  const other: Tool = {
    name: "read",
    description: "read",
    parameters: { type: "object", properties: {} },
  };

  const declared: Tool = {
    name: RESULT_TOOL_NAME,
    description: "submit",
    parameters: { type: "object" },
  };

  it("gives submit_result the envelope and leaves other tools alone", () => {
    const messages: Array<Message> = [
      {
        role: "system",
        content: "",
        toolsAdded: [other, declared],
        timestamp: 0,
      },
      { role: "user", content: "go", timestamp: 1 },
    ];

    const tools = getCurrentTools([...declareSchema(messages, REPORT)]);

    assert.deepStrictEqual(
      tools.find((tool) => tool.name === "read"),
      other
    );
    assert.deepStrictEqual(
      tools.find((tool) => tool.name === RESULT_TOOL_NAME)?.parameters,
      {
        type: "object",
        properties: {
          result: REPORT,
          divergence: {
            type: "string",
            description:
              'How the work differs from the brief, or "None" when it does not.',
          },
        },
        required: ["result", "divergence"],
        additionalProperties: false,
      }
    );
  });
});
