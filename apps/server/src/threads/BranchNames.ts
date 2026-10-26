// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// packages/provider-core/src/server/textGenerationPrompts.ts (`buildBranchNamePrompt` and
// `buildPromptFromMessage`, fragment mode) and textGenerationUtils.ts (`limitSection`). Kept: the
// prompt's rules, the JSON answer `{branch}`, the 8,000 character message budget, and the
// fragment sanitized like t3code's `sanitizeBranchFragment`. Changed: one naming mode (a bare
// fragment, no prefix); no attachments or policy instructions; when there is no model or it fails,
// the name is a slug of the message's first words, so a rename always has a name.
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

import { Context, Effect, Layer, Option, Schema } from "effect";

import { sanitizeBranchFragment } from "../projects/Worktrees.ts";
import { decodeJsonAnswer, TitleModel } from "./TitleModel.ts";

const limitSection = (value: string, maxChars: number) =>
  value.length <= maxChars
    ? value
    : `${value.slice(0, maxChars)}\n\n[truncated]`;

const BranchAnswer = Schema.Struct({ branch: Schema.String });

/** The prompt that asks for a branch name for the work `message` asks for. */
export const buildBranchNamePrompt = (message: string) =>
  [
    "You generate concise git branch names.",
    "Return a JSON object with key: branch.",
    "Rules:",
    "- Branch should describe the requested work from the user message.",
    "- Return a valid Git branch name without spaces.",
    "- Keep it short and specific (2-6 words), in lowercase with hyphen-separated words.",
    "- Return only the descriptive branch fragment, without a prefix or namespace. The application adds the configured prefix.",
    "- If images are attached, use them as primary context for visual/UI issues.",
    "",
    "User message:",
    limitSection(message, 8000),
  ].join("\n");

/** A branch name from the first five words of `message`, for when no model answers. */
export const slugBranchName = (message: string) =>
  sanitizeBranchFragment(
    message
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((word) => word.length > 0)
      .slice(0, 5)
      .join("-")
  );

/** Names a thread's branch from its first message. */
export class BranchNames extends Context.Service<
  BranchNames,
  {
    /** A branch name for the work `message` asks for: the model's, else a slug of the message. */
    generate(message: string): Effect.Effect<string>;
  }
>()("cairn/server/threads/BranchNames") {
  /** Over the ambient `TitleModel`. */
  static readonly layerNoDeps = Layer.effect(
    BranchNames,
    Effect.gen(function* () {
      const model = yield* TitleModel;

      const generate = Effect.fn("BranchNames.generate")(function* (
        message: string
      ) {
        const answer = yield* model.complete(buildBranchNamePrompt(message));

        const fromModel = Option.flatMap(answer, (text) =>
          Option.map(decodeJsonAnswer(BranchAnswer, text), (decoded) =>
            decoded.branch.trim()
          )
        ).pipe(Option.filter((branch) => branch !== ""));

        return Option.match(fromModel, {
          onNone: () => slugBranchName(message),
          onSome: sanitizeBranchFragment,
        });
      });

      return BranchNames.of({ generate });
    })
  );
}
