// The transcript reads the brain's inputs by their words (client-logic's `brainInputText`): these
// cases hold that reading to the renderers here, so a change to a wake's, a question's, a brief's or
// a nudge's words that the transcript would no longer recognise fails in this file.

import { brainInputText } from "@cairn/client-logic/TimelineEntries";
import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { NUDGE_TEXT } from "../models/ResultTool.ts";
import { briefOf } from "../subagents/Briefs.ts";
import { renderBrief, renderQuestion, renderWake } from "./SubagentText.ts";

describe("the brain's inputs as the transcript shows them", () => {
  it("names the subagent row in a wake, not the note the model reads", () => {
    assert.strictEqual(
      brainInputText(renderWake("Probe the bridge")),
      'Subagent "Probe the bridge" reported; its result is on its subagent row above.'
    );
  });

  it("leaves the instruction meant for the parent's model out of a question", () => {
    assert.strictEqual(
      brainInputText(renderQuestion("Probe the bridge", "Which port?")),
      'Subagent "Probe the bridge" asks: Which port?'
    );
  });

  it("leaves the submit_result instruction out of a typed child's brief", () => {
    assert.strictEqual(
      brainInputText(
        renderBrief(
          Result.getOrThrow(
            briefOf(
              {
                description: "Count the tests",
                brief: "Count the test files under apps.",
                why: Option.some("The plan needs it."),
                isolation: Option.none(),
                resultSchema: Option.some({
                  type: "object",
                  properties: { count: { type: "number" } },
                }),
                wake: Option.none(),
                model: Option.none(),
              },
              "full-access"
            )
          )
        )
      ),
      "Count the tests\n\nCount the test files under apps.\n\nWhy: The plan needs it."
    );
  });

  it("says what Cairn asked instead of a typed child's nudge", () => {
    assert.strictEqual(
      brainInputText(NUDGE_TEXT),
      "Cairn asked the subagent for the typed result its brief names."
    );
  });
});
