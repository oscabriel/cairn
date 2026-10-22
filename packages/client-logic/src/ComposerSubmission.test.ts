// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerSubmission.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: results are values rather than callback
// calls, and the citation and plan cases are gone. MIT License, Copyright (c) 2026 T3 Tools Inc.;
// the full notice is in ComposerSubmission.ts.
import { assert, describe, it } from "@effect/vitest";

import {
  ComposerSubmission,
  submitComposerDraft,
  TURN_TEXT_MAX_CHARS,
} from "./ComposerSubmission.ts";

const { Dispatch, Empty, Refuse } = ComposerSubmission.cases;

describe(submitComposerDraft, () => {
  it("keeps an oversized draft editable and sends a corrected follow-up", () => {
    assert.deepStrictEqual(
      submitComposerDraft("x".repeat(TURN_TEXT_MAX_CHARS + 1), "turn", false),
      Refuse.make({
        message:
          "Prompt is 1 character over the 120,000-character limit. Shorten or split it before sending.",
      })
    );
    assert.deepStrictEqual(
      submitComposerDraft("Corrected prompt", "turn", false),
      Dispatch.make({ text: "Corrected prompt" })
    );
  });

  it("counts characters in the plural", () => {
    assert.deepStrictEqual(
      submitComposerDraft("x".repeat(TURN_TEXT_MAX_CHARS + 18), "turn", false),
      Refuse.make({
        message:
          "Prompt is 18 characters over the 120,000-character limit. Shorten or split it before sending.",
      })
    );
  });

  it("allows a draft at the limit", () => {
    assert.strictEqual(
      submitComposerDraft("x".repeat(TURN_TEXT_MAX_CHARS), "turn", false)._tag,
      "Dispatch"
    );
  });

  it("allows surrounding whitespace the turn contract trims", () => {
    const draft = ` ${"x".repeat(TURN_TEXT_MAX_CHARS)} `;

    assert.deepStrictEqual(
      submitComposerDraft(draft, "turn", false),
      Dispatch.make({ text: "x".repeat(TURN_TEXT_MAX_CHARS) })
    );
  });

  it("does not hold answers to a pending question to the turn limit", () => {
    assert.strictEqual(
      submitComposerDraft(
        "x".repeat(TURN_TEXT_MAX_CHARS + 1),
        "pending-user-input",
        false
      )._tag,
      "Dispatch"
    );
  });

  it("has nothing to send without text or attachments", () => {
    assert.deepStrictEqual(
      submitComposerDraft("  \n ", "turn", false),
      Empty.make({})
    );
    assert.deepStrictEqual(
      submitComposerDraft("", "turn", true),
      Dispatch.make({ text: "" })
    );
  });
});
