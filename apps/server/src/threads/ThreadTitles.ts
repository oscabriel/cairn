// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// packages/provider-core/src/server/textGenerationPrompts.ts (`INITIAL_THREAD_TITLE_PROMPT` and
// `buildThreadTitlePrompt` for a first message), threadTitleContext.ts (`limitTitleMessage`) and
// textGenerationUtils.ts (`sanitizeThreadTitle`). Kept: the prompt's editorial rules, the JSON
// answer `{title, needsRefinement}`, the 8,000 character message budget, and the sanitizing of the
// answer. Changed: "T3 Code" is "Cairn"; no regeneration from a whole thread, linked context,
// attachments or policy instructions; the placeholder before the model answers is the message's
// first line rather than "New thread".
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

import { decodeJsonAnswer, TitleModel } from "./TitleModel.ts";

/** The title a thread shows when its first message gives nothing to go on. */
export const DEFAULT_THREAD_TITLE = "New thread";

const MAX_THREAD_TITLE_CHARS = 120;

const MAX_PLACEHOLDER_CHARS = 80;

const TRUNCATED = "\n[Content truncated]\n";

const INITIAL_THREAD_TITLE_PROMPT = `Generate a title that will help the user recognize this Cairn thread weeks later.
Return JSON with keys title and needsRefinement.
Set needsRefinement to true only if the subject is still unknown, such as an unresolved link, "fix this", or an unexplained attachment. Otherwise set it to false.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, subagents, tools, output formats, and monitoring instructions do not belong in the title unless they are themselves the topic.
- For reviews, name what is being reviewed and the relevant concern. Avoid generic titles such as "Review PR 123" when linked or attached context reveals the subject.
- For research, name the question domain rather than the requested research process.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project names already visible in the UI, quotes, labels, filler, and trailing punctuation.
- Use attached images as primary context for UI issues.
- When a URL or attachment is the only source of the subject, use available tools to inspect it directly.
- Local git history is not evidence of what a linked PR or issue is about. Never title the thread after branch names, commit messages, or merged commits found in the checkout.
- If a linked PR or issue cannot be read, fall back to the user's stated action plus its number, such as "Take Over PR 8588". This is the one case where a PR or issue number belongs in the title.`;

const TitleAnswer = Schema.Struct({ title: Schema.String });

/** Keeps the start and the end of a long message within `budget` characters. */
export const limitTitleMessage = (text: string, budget: number) => {
  if (text.length <= budget) {
    return text;
  }

  if (budget <= TRUNCATED.length) {
    return "";
  }

  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tailLength = available - head;

  return `${text.slice(0, head)}${TRUNCATED}${tailLength > 0 ? text.slice(-tailLength) : ""}`;
};

/** The prompt that asks for a first message's title. */
export const buildThreadTitlePrompt = (message: string) =>
  `${INITIAL_THREAD_TITLE_PROMPT}\n\nUser message:\n${limitTitleMessage(message, 8000)}`;

/** One clean line of at most 120 characters, without wrapping quotes; none when nothing is left. */
export const sanitizeThreadTitle = (raw: string): Option.Option<string> => {
  const normalized = (raw.trim().split(/\r?\n/u)[0] ?? "")
    .trim()
    .replaceAll(/^['"`]+|['"`]+$/gu, "")
    .trim()
    .replaceAll(/\s+/gu, " ");

  if (normalized.length === 0) {
    return Option.none();
  }

  return Option.some(
    normalized.length <= MAX_THREAD_TITLE_CHARS
      ? normalized
      : `${normalized.slice(0, MAX_THREAD_TITLE_CHARS - 3).trimEnd()}...`
  );
};

/** The title a thread shows until its model title arrives: the message's first line, shortened. */
export const placeholderTitle = (message: string) =>
  Option.getOrElse(
    Option.map(sanitizeThreadTitle(message), (line) =>
      line.length <= MAX_PLACEHOLDER_CHARS
        ? line
        : `${line.slice(0, MAX_PLACEHOLDER_CHARS - 3).trimEnd()}...`
    ),
    () => DEFAULT_THREAD_TITLE
  );

/** Names threads from their first message with the cheap model. */
export class ThreadTitles extends Context.Service<
  ThreadTitles,
  {
    /** A model title for a thread whose first message is `message`; none when the model gave none. */
    generate(message: string): Effect.Effect<Option.Option<string>>;
  }
>()("cairn/server/threads/ThreadTitles") {
  /** Over the ambient `TitleModel`. */
  static readonly layerNoDeps = Layer.effect(
    ThreadTitles,
    Effect.gen(function* () {
      const model = yield* TitleModel;

      const generate = Effect.fn("ThreadTitles.generate")(function* (
        message: string
      ) {
        if (message.trim() === "") {
          return Option.none<string>();
        }

        const answer = yield* model.complete(buildThreadTitlePrompt(message));

        // An answer that is not the JSON asked for (a refusal, prose) gives no title, so the
        // placeholder stays instead of the model's words becoming the title (T34).
        return Option.flatMap(answer, (text) =>
          Option.flatMap(
            Option.map(
              decodeJsonAnswer(TitleAnswer, text),
              (decoded) => decoded.title
            ),
            sanitizeThreadTitle
          )
        );
      });

      return ThreadTitles.of({ generate });
    })
  );
}
