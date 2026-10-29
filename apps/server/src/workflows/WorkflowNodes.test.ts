// The pure parts of the node tools: which script-call endings are code mode's replay endings, and
// how row texts are cut to what the protocol decodes.

import { assert, describe, it } from "@effect/vitest";

import {
  cutText,
  DISPLAY_TEXT_LIMIT,
  isReplayEnding,
} from "./WorkflowNodes.ts";

describe(isReplayEnding, () => {
  it("names both of pi-durable code mode's replay endings", () => {
    assert.isTrue(
      isReplayEnding(
        "The script cannot resume: it started under code mode version 1, this is 2."
      )
    );
    assert.isTrue(
      isReplayEnding(
        "The script took a different path when resumed after a restart: it ended after result 3, where it went on before."
      )
    );
  });

  it("leaves a script's own error that merely mentions a replay as a script error", () => {
    assert.isFalse(isReplayEnding("TypeError: replay buffer is undefined"));
    assert.isFalse(isReplayEnding("the values diverged from the expected"));
  });
});

describe(cutText, () => {
  it("keeps a short text and cuts a long one to the display limit", () => {
    assert.strictEqual(cutText("short"), "short");
    assert.strictEqual(cutText("x".repeat(9000)).length, DISPLAY_TEXT_LIMIT);
  });
});
