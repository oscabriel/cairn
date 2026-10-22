// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerPromptHistory.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Changed: the terminal, review, citation and
// automation cases are gone; Cairn's attachment and skill parts are dropped from recall instead.
// MIT License, Copyright (c) 2026 T3 Tools Inc.; the full notice is in ComposerPromptHistory.ts.
import { attachmentText } from "@cairn/protocol/Attachments";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import {
  buildComposerPromptHistoryEntries,
  recallableComposerPrompt,
  stepComposerPromptHistory,
} from "./ComposerPromptHistory.ts";
import type { ComposerPromptHistoryPosition } from "./ComposerPromptHistory.ts";

const message = (id: string, role: string, text: string) => ({
  id,
  role,
  texts: [text],
});

const entries = buildComposerPromptHistoryEntries([
  message("m1", "user", "first"),
  message("a1", "assistant", "reply"),
  message("m2", "user", "second"),
  message("m3", "user", "third"),
]);

const at = (entryId: string, recalled: string) =>
  Option.some<ComposerPromptHistoryPosition>({ entryId, recalled });

const backward = (
  position: Option.Option<ComposerPromptHistoryPosition>,
  current: string
) => stepComposerPromptHistory("backward", entries, position, current);

const forward = (
  position: Option.Option<ComposerPromptHistoryPosition>,
  current: string
) => stepComposerPromptHistory("forward", entries, position, current);

describe(recallableComposerPrompt, () => {
  it("drops attachment and skill parts the brain added", () => {
    assert.strictEqual(
      recallableComposerPrompt([
        "  Look at this  ",
        attachmentText({
          name: "notes.txt",
          mimeType: "text/plain",
          path: "/data/attachments/a1.txt",
          text: "hello",
        }),
        '<skill name="review" location="/skills/review/SKILL.md">\nbody\n</skill>',
      ]),
      "Look at this"
    );
  });

  it("returns an empty string when only added parts were sent", () => {
    assert.strictEqual(recallableComposerPrompt(["   "]), "");
  });
});

describe(buildComposerPromptHistoryEntries, () => {
  it("keeps user messages with text, oldest first", () => {
    assert.deepStrictEqual(
      entries.map((entry) => entry.prompt),
      ["first", "second", "third"]
    );
  });

  it("collapses consecutive duplicates onto the newest message id", () => {
    assert.deepStrictEqual(
      buildComposerPromptHistoryEntries([
        message("m1", "user", "same"),
        message("m2", "user", "same"),
        message("m3", "user", "other"),
        message("m4", "user", "same"),
      ]),
      [
        { id: "m2", prompt: "same" },
        { id: "m3", prompt: "other" },
        { id: "m4", prompt: "same" },
      ]
    );
  });
});

describe(stepComposerPromptHistory, () => {
  it("does not start browsing from a non-empty draft", () => {
    assert.isTrue(Option.isNone(backward(Option.none(), "typing")));
  });

  it("walks back from the newest entry", () => {
    const first = Option.getOrThrow(backward(Option.none(), ""));

    assert.deepStrictEqual(first, {
      position: at("m3", "third"),
      prompt: "third",
    });
    assert.deepStrictEqual(
      Option.map(backward(first.position, "third"), ({ prompt }) => prompt),
      Option.some("second")
    );
  });

  it("is a no-op at the oldest entry so the caret keeps moving", () => {
    assert.isTrue(Option.isNone(backward(at("m1", "first"), "first")));
  });

  it("walks forward and empties the composer past the newest entry", () => {
    const newer = Option.getOrThrow(forward(at("m2", "second"), "second"));

    assert.strictEqual(newer.prompt, "third");
    assert.deepStrictEqual(
      forward(newer.position, "third"),
      Option.some({ position: Option.none(), prompt: "" })
    );
  });

  it("treats an edited recall as a fresh draft", () => {
    const position = at("m3", "third");

    assert.isTrue(Option.isNone(backward(position, "third edited")));
    assert.isTrue(Option.isNone(forward(position, "third edited")));
    assert.deepStrictEqual(
      Option.map(backward(position, ""), (step) => step.position),
      Option.some(at("m3", "third"))
    );
  });

  it("does nothing on forward when not browsing", () => {
    assert.isTrue(Option.isNone(forward(Option.none(), "")));
  });

  it("follows the entry by id when the list changes under it", () => {
    const grown = buildComposerPromptHistoryEntries([
      message("m0", "user", "zeroth"),
      message("m1", "user", "A"),
      message("m2", "user", "B"),
      message("m3", "user", "A"),
    ]);

    assert.deepStrictEqual(
      Option.map(
        stepComposerPromptHistory("backward", grown, at("m1", "A"), "A"),
        ({ prompt }) => prompt
      ),
      Option.some("zeroth")
    );
    assert.isTrue(
      Option.isNone(
        stepComposerPromptHistory(
          "forward",
          grown,
          at("gone", "not sent"),
          "not sent"
        )
      )
    );
  });

  it("falls back to matching text when a duplicate collapse retires the id", () => {
    const collapsed = buildComposerPromptHistoryEntries([
      message("m1", "user", "first"),
      message("m3", "user", "A"),
    ]);

    assert.deepStrictEqual(
      Option.map(
        stepComposerPromptHistory("backward", collapsed, at("m2", "A"), "A"),
        ({ prompt }) => prompt
      ),
      Option.some("first")
    );
  });

  it("has nothing to recall in an empty thread", () => {
    assert.isTrue(
      Option.isNone(
        stepComposerPromptHistory("backward", [], Option.none(), "")
      )
    );
  });
});
