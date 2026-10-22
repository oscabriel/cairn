// The plain-text reading of one projected transcript entry, for the skeleton's thread page. An
// entry's `model` holds pi-ai messages as the brain projected them; this reads their role and
// their text, names tool calls and images, and ignores anything it does not recognise, so a newer
// brain never breaks the page. The full transcript (markdown, folds, tool cards) replaces this.
import type { Entry } from "@cairn/protocol/Thread";
import { Array, Match, Option, Predicate, Schema } from "effect";

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const ThinkingPart = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
});

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("toolCall"),
  name: Schema.String,
});

const ImagePart = Schema.Struct({ type: Schema.Literal("image") });

const Part = Schema.Union([TextPart, ThinkingPart, ToolCallPart, ImagePart]);

const ModelMessage = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]),
});

const decodeModelMessage = Schema.decodeUnknownOption(ModelMessage);

const decodePart = Schema.decodeUnknownOption(Part);

/** One line of the plain transcript: who spoke and what they said. */
export interface EntryLine {
  readonly role: string;
  readonly text: string;
}

const partText = (part: typeof Part.Type): string =>
  Match.value(part).pipe(
    Match.when({ type: "text" }, ({ text }) => text),
    Match.when(
      { type: "thinking" },
      ({ thinking }) => `(thinking) ${thinking}`
    ),
    Match.when({ type: "toolCall" }, ({ name }) => `[tool call: ${name}]`),
    Match.when({ type: "image" }, () => "[image]"),
    Match.exhaustive
  );

const messageLine = (message: typeof ModelMessage.Type): EntryLine => ({
  role: message.role,
  text: Predicate.isString(message.content)
    ? message.content
    : Array.getSomes(message.content.map((part) => decodePart(part)))
        .map(partText)
        .join("\n"),
});

/** The lines an entry shows: one per pi-ai message it carries; none for entries without messages. */
export const entryLines = (entry: Entry): ReadonlyArray<EntryLine> =>
  Option.match(Option.fromUndefinedOr(entry.model), {
    onNone: () => [],
    onSome: (messages) =>
      Array.getSomes(
        messages.map((message) => decodeModelMessage(message))
      ).map(messageLine),
  });
