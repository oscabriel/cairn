// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerSubmission.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a draft over the turn's character limit stays in
// the composer with a message that says by how much, surrounding whitespace does not count, and an
// answer to a pending question is not held to the turn limit. Changed: the check returns what to do
// instead of calling a send callback and an event's `preventDefault`; citation expansion is gone
// (Cairn has no citations); an empty draft with no attachment is "nothing to send".
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import { Option, Schema } from "effect";

/** The longest text one turn may carry, as `TurnInput` in the protocol checks it. */
export const TURN_TEXT_MAX_CHARS = 120_000;

/** Where a draft goes: a new turn of the thread, or the answer to a question the agent asked. */
export type SubmissionTarget = "turn" | "pending-user-input";

const numbers = new Intl.NumberFormat("en-US");

/** The message for a prompt over the turn limit, or none when it fits. Whitespace at the ends is free. */
export const composerPromptLengthMessage = (
  prompt: string
): Option.Option<string> => {
  const excess = prompt.trim().length - TURN_TEXT_MAX_CHARS;

  if (excess <= 0) {
    return Option.none();
  }

  const unit = excess === 1 ? "character" : "characters";

  return Option.some(
    `Prompt is ${numbers.format(excess)} ${unit} over the ${numbers.format(TURN_TEXT_MAX_CHARS)}-character limit. Shorten or split it before sending.`
  );
};

/**
 * What pressing send does with a draft: send the trimmed text, keep the draft and say why it cannot
 * go, or nothing (no text and no attachment).
 */
export const ComposerSubmission = Schema.TaggedUnion({
  Dispatch: { text: Schema.String },
  Refuse: { message: Schema.String },
  Empty: {},
});

export type ComposerSubmission = typeof ComposerSubmission.Type;

const { Dispatch, Empty, Refuse } = ComposerSubmission.cases;

/** Decides what a send does with `prompt`. A turn is held to the limit; an answer is not. */
export const submitComposerDraft = (
  prompt: string,
  target: SubmissionTarget,
  hasAttachments: boolean
): ComposerSubmission => {
  const text = prompt.trim();

  if (text.length === 0 && !hasAttachments) {
    return Empty.make({});
  }

  if (target === "pending-user-input") {
    return Dispatch.make({ text });
  }

  return Option.match(composerPromptLengthMessage(prompt), {
    onNone: () => Dispatch.make({ text }),
    onSome: (message) => Refuse.make({ message }),
  });
};
