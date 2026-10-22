// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/composerPromptHistory.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: ArrowUp in an empty composer walks back through
// what the user sent in this thread, ArrowDown walks forward and past the newest empties the
// composer, an edited recall is a fresh draft, consecutive duplicates collapse onto the newest, and
// the walk follows an entry by id when the list changes under it. Changed: a Cairn user message is
// pi-ai text parts, so recall drops the parts the brain added (attachment text blocks and expanded
// `<skill>` blocks) instead of t3code's terminal, review and citation blocks; positions are
// `Option` values.
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
import { parseAttachmentText } from "@cairn/protocol/Attachments";
import { Array, Option, Schema } from "effect";

/** One message of the thread, reduced to what recall reads: its id, role and text parts. */
export interface ComposerPromptHistoryMessage {
  readonly id: string;
  readonly role: string;
  readonly texts: ReadonlyArray<string>;
}

/** One prompt the user can recall, under the id of the message that sent it. */
export interface ComposerPromptHistoryEntry {
  readonly id: string;
  readonly prompt: string;
}

/** Where a walk through the history stands: the entry shown and the text it put in the composer. */
export const ComposerPromptHistoryPosition = Schema.Struct({
  entryId: Schema.String,
  recalled: Schema.String,
});

export type ComposerPromptHistoryPosition =
  typeof ComposerPromptHistoryPosition.Type;

/** One step of a walk: the new position (none past the newest) and the composer's new text. */
export interface ComposerPromptHistoryStep {
  readonly position: Option.Option<ComposerPromptHistoryPosition>;
  readonly prompt: string;
}

const SKILL_BLOCK = /^<skill name="[^"]*"/u;

/** True for text parts the brain added to a turn: attachment blocks and expanded skills. */
const isAddedPart = (text: string): boolean =>
  Option.isSome(parseAttachmentText(text)) || SKILL_BLOCK.test(text.trim());

/** What the user typed in a sent message, without the parts the brain added. */
export const recallableComposerPrompt = (
  texts: ReadonlyArray<string>
): string =>
  Array.filter(texts, (text) => !isAddedPart(text))
    .join("\n")
    .trim();

/** The user's prompts, oldest first, consecutive duplicates collapsed onto the newest message. */
export const buildComposerPromptHistoryEntries = (
  messages: ReadonlyArray<ComposerPromptHistoryMessage>
): ReadonlyArray<ComposerPromptHistoryEntry> => {
  const entries: Array<ComposerPromptHistoryEntry> = [];

  for (const message of messages) {
    const prompt =
      message.role === "user" ? recallableComposerPrompt(message.texts) : "";

    if (prompt.length > 0) {
      const previous = entries.at(-1);

      if (previous !== undefined && previous.prompt === prompt) {
        entries[entries.length - 1] = { id: message.id, prompt };
      } else {
        entries.push({ id: message.id, prompt });
      }
    }
  }

  return entries;
};

const findActive = (
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: ComposerPromptHistoryPosition
): number => {
  const byId = entries.findIndex((entry) => entry.id === position.entryId);

  return byId === -1
    ? entries.findLastIndex((entry) => entry.prompt === position.recalled)
    : byId;
};

const stepTo = (
  entry: ComposerPromptHistoryEntry
): ComposerPromptHistoryStep => ({
  position: Option.some({ entryId: entry.id, recalled: entry.prompt }),
  prompt: entry.prompt,
});

/**
 * One step through the history, or none when the key should move the caret instead: a walk back
 * never starts from a non-empty draft, and the oldest entry is the end.
 */
export const stepComposerPromptHistory = (
  direction: "backward" | "forward",
  entries: ReadonlyArray<ComposerPromptHistoryEntry>,
  position: Option.Option<ComposerPromptHistoryPosition>,
  currentPrompt: string
): Option.Option<ComposerPromptHistoryStep> => {
  const activeIndex = Option.match(
    Option.filter(position, ({ recalled }) => recalled === currentPrompt),
    {
      onNone: () => -1,
      onSome: (current) => findActive(entries, current),
    }
  );

  if (direction === "backward") {
    if (activeIndex < 0 && currentPrompt.length > 0) {
      return Option.none();
    }

    const index = activeIndex < 0 ? entries.length - 1 : activeIndex - 1;

    return Option.map(Array.get(entries, index), stepTo);
  }

  if (activeIndex < 0) {
    return Option.none();
  }

  return Option.some(
    Option.match(Array.get(entries, activeIndex + 1), {
      onNone: () => ({ position: Option.none(), prompt: "" }),
      onSome: stepTo,
    })
  );
};
