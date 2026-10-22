// The inputs waiting in a thread's queue, read from pi-durable's `pi.inbox` document in the
// projected view. An item is a steer or a follow-up with the user's content; writes (display-only
// entries) are not the user's and are not shown. Anything this build cannot read is skipped, so a
// newer brain never breaks the composer.
import { SubmissionId } from "@cairn/protocol/Ids";
import type { ConversationView } from "@cairn/protocol/Thread";
import { Array, Option, Record, Schema } from "effect";

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const UserContent = Schema.Union([Schema.String, Schema.Array(Schema.Json)]);

const InboxItem = Schema.Struct({
  id: SubmissionId,
  mode: Schema.Literals(["steer", "followUp"]),
  content: UserContent,
});

const InboxDoc = Schema.Struct({ items: Schema.Array(Schema.Json) });

const decodeInbox = Schema.decodeUnknownOption(InboxDoc);

const decodeItem = Schema.decodeUnknownOption(InboxItem);

const decodeTextPart = Schema.decodeUnknownOption(TextPart);

/** One queued input as the composer lists it. */
export interface QueuedInput {
  readonly submissionId: SubmissionId;
  readonly mode: "steer" | "followUp";
  /** The input's text, or a note when it carries only attachments. */
  readonly text: string;
}

const contentText = (content: typeof UserContent.Type): string => {
  if (Schema.is(Schema.String)(content)) {
    return content;
  }

  return Array.getSomes(content.map((part) => decodeTextPart(part)))
    .map(({ text }) => text)
    .join("\n");
};

/** The user inputs waiting in the view's `pi.inbox`, oldest first. */
export const queuedInputs = (
  view: Option.Option<ConversationView>
): ReadonlyArray<QueuedInput> =>
  Option.match(
    Option.flatMap(
      Option.flatMap(view, (current) => Record.get(current.docs, "pi.inbox")),
      decodeInbox
    ),
    {
      onNone: () => [],
      onSome: (inbox) =>
        Array.getSomes(inbox.items.map((item) => decodeItem(item))).map(
          (item) => {
            const text = contentText(item.content).trim();

            return {
              submissionId: item.id,
              mode: item.mode,
              text: text.length === 0 ? "(attachments)" : text,
            };
          }
        ),
    }
  );
