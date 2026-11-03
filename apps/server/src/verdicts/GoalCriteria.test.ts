// The goal tools' pure rules: `goal_criteria`'s refusals name the field, a model judge that names
// no model judges on the thread's own (ADR 0043), the bridge refused as a judge, the judge's prompt
// and how its reply reads.

import { ModelSpec } from "@cairn/protocol/ModelSpecs";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { goalListing, judgeLine, proposalsOf } from "./GoalCriteria.ts";
import type { CriterionArgs } from "./GoalCriteria.ts";
import { NO_GOAL } from "./GoalDocs.ts";
import {
  judgeModelRefusal,
  modelJudgePrompt,
  parseModelVerdict,
  TRANSCRIPT_LIMIT,
} from "./ModelJudge.ts";
import { applyBind } from "./Verdicts.ts";

const refusalOf = (criteria: ReadonlyArray<CriterionArgs>): string =>
  Result.match(proposalsOf(criteria), {
    onFailure: (text) => text,
    onSuccess: () => "",
  });

describe("goal_criteria's arguments", () => {
  it("parses command, user and model judges with their defaults", () => {
    const parsed = proposalsOf([
      { text: " Tests pass ", judge: "command", argv: ["npm", "test"] },
      { text: "The user likes it", judge: "user" },
      {
        text: "The README explains setup",
        judge: "model",
        model: "opencode-go/gpt-6-luna:high",
        rubric: "A setup section with commands",
      },
      {
        text: "The tone is calm",
        judge: "model",
        rubric: "No exclamation marks",
      },
    ]);

    assert.isTrue(Result.isSuccess(parsed));
    assert.deepStrictEqual(
      Result.getOrThrow(parsed).map((proposal) => proposal.judge),
      [
        {
          kind: "command",
          argv: ["npm", "test"],
          expectExit: 0,
          timeoutSec: 600,
        },
        { kind: "user" },
        {
          kind: "model",
          spec: ModelSpec.make("opencode-go/gpt-6-luna:high"),
          rubric: "A setup section with commands",
        },
        { kind: "model", spec: null, rubric: "No exclamation marks" },
      ]
    );
    assert.deepStrictEqual(
      Result.getOrThrow(parsed).map((proposal) => judgeLine(proposal.judge)),
      [
        "command `npm test`",
        "the user",
        "model opencode-go/gpt-6-luna:high",
        "model (this thread's)",
      ]
    );
    assert.strictEqual(Result.getOrThrow(parsed)[0]?.text, "Tests pass");
  });

  it("refuses naming the field", () => {
    assert.include(
      refusalOf([{ text: "Tests pass", judge: "command" }]),
      "criteria[0].argv"
    );
    assert.include(
      refusalOf([
        { text: "ok", judge: "user" },
        {
          text: "Reads well",
          judge: "model",
          model: "@judge",
          rubric: "clear",
        },
      ]),
      'criteria[1].model: "@judge" is a role, and roles'
    );
    assert.include(
      refusalOf([{ text: "Reads well", judge: "model" }]),
      "criteria[0].rubric"
    );
    assert.include(
      refusalOf([{ text: "Verified", judge: "verification" }]),
      "criteria[0].judge"
    );
    assert.include(
      refusalOf([{ text: "  ", judge: "user" }]),
      "criteria[0].text"
    );
    assert.include(
      refusalOf([
        {
          text: "Reads well",
          judge: "model",
          model: "not a spec",
          rubric: "clear",
        },
      ]),
      "criteria[0]"
    );
    assert.include(refusalOf([]), "criteria:");
  });

  it("lists a goal with ids, states and judges for the model", () => {
    const goal = NO_GOAL();

    assert.include(goalListing(goal), "no criteria yet");

    applyBind(
      goal,
      {
        objective: Option.some("Ship the parser"),
        criteria: Result.getOrThrow(
          proposalsOf([
            { text: "Tests pass", judge: "command", argv: ["npm", "test"] },
          ])
        ),
        mode: "replace",
      },
      1
    );

    const listing = goalListing(goal);

    assert.include(listing, "Goal: Ship the parser");
    assert.include(listing, "0 of 1 criteria met");
    assert.include(
      listing,
      "- c1 [open] Tests pass; judged by command `npm test`"
    );
  });
});

const CLAUDE = { provider: "anthropic", modelId: "claude-opus-5-5" };

describe("which models may judge", () => {
  it("refuses the Claude bridge, named or as the thread's own model", () => {
    const bridge = { provider: "claude-bridge", modelId: "claude-haiku-5-5" };

    assert.include(
      Option.getOrThrow(judgeModelRefusal(bridge, true)),
      "Name a model served by another provider"
    );
    assert.include(
      Option.getOrThrow(judgeModelRefusal(bridge, false)),
      "This thread runs on claude-bridge/claude-haiku-5-5"
    );
  });

  it("lets any other model judge, the thread's own and its family included", () => {
    assert.deepStrictEqual(
      [
        judgeModelRefusal(CLAUDE, false),
        judgeModelRefusal(
          { provider: "opencode-go", modelId: "claude-haiku-5-5" },
          true
        ),
        judgeModelRefusal(
          { provider: "opencode-go", modelId: "gpt-6-luna" },
          true
        ),
      ].map(Option.isNone),
      [true, true, true]
    );
  });
});

describe("the model judge's words", () => {
  it("asks over the rubric and the transcript's end", () => {
    const prompt = modelJudgePrompt({
      objective: "Ship the parser",
      criterion: "Tests pass",
      rubric: "A test run with no failures",
      transcript: `${"x".repeat(TRANSCRIPT_LIMIT)}THE END`,
    });

    assert.include(prompt, "Criterion: Tests pass");
    assert.include(prompt, "Rubric: A test run with no failures");
    assert.include(prompt, "[earlier transcript left out]");
    assert.include(prompt, "THE END");
    assert.isBelow(prompt.length, TRANSCRIPT_LIMIT + 1000);
  });

  it("reads MET and NOT MET on the first line, and anything else as not met", () => {
    assert.deepStrictEqual(
      [
        "MET\nThe run shows 12 passed.",
        "**NOT MET**: three tests fail",
        "met.",
        "Not met",
        "I think it is met",
        "",
      ].map((reply) => {
        const read = parseModelVerdict(reply);

        return [read.ok, read.understood];
      }),
      [
        [true, true],
        [false, true],
        [true, true],
        [false, true],
        [false, false],
        [false, false],
      ]
    );
  });
});
