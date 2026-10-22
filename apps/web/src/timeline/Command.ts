// The transcript's effects: paging in older turns through `thread.history`, preparing a Retry for
// the outbox, the clipboard, and loading a code block's grammar when it mounts.
import { AttachmentId, EntryId, ThreadId } from "@cairn/protocol/Ids";
import { SendInput } from "@cairn/protocol/Thread";
import { Duration, Effect, Option, Schema } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";

import { mintRequestId } from "../composer/Ids.ts";
import { CairnConnection } from "../connection/Connection.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { loadLanguage } from "./markdown/Highlight.ts";
import { Message } from "./Message.ts";

/** How many entries one "Load earlier turns" asks for. */
export const HISTORY_PAGE_LIMIT = 200;

/** How long a copy button shows its check. */
const COPIED_FOR = Duration.millis(1500);

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** Pages in the entries before `before`. */
export const LoadEarlier = Command.define("LoadEarlier", {
  args: { threadId: Schema.String, before: EntryId },
  messages: [Message.LoadedEarlier, Message.FailedEarlier],
  execute: ({ before, threadId }) =>
    Option.match(decodeThreadId(threadId), {
      onNone: () => Effect.succeed(Message.FailedEarlier({ threadId })),
      onSome: (id) =>
        Effect.flatMap(CairnConnection.get, (client) =>
          client["thread.history"]({
            threadId: id,
            conversationId: Option.none(),
            before,
            limit: HISTORY_PAGE_LIMIT,
          })
        ).pipe(
          Effect.match({
            onSuccess: (page) => Message.LoadedEarlier({ threadId, page }),
            onFailure: () => Message.FailedEarlier({ threadId }),
          })
        ),
    }),
});

/** Mints a request id and hands back the failed turn's prompt as a `thread.send`. */
export const PrepareRetry = Command.define("PrepareRetry", {
  args: {
    threadId: ThreadId,
    text: Schema.String,
    attachments: Schema.Array(AttachmentId),
    skillRefs: Schema.Array(Schema.String),
  },
  messages: [Message.PreparedRetry],
  execute: ({ attachments, skillRefs, text, threadId }) =>
    Effect.map(mintRequestId, (requestId) =>
      Message.PreparedRetry({
        item: OutboxItem.Send({
          input: SendInput.make({
            threadId,
            input: {
              requestId,
              text,
              attachments,
              skillRefs: skillRefs.filter((skill) => skill.trim() !== ""),
            },
            whenBusy: "followUp",
          }),
        }),
      })
    ),
});

/** Writes `text` to the clipboard. */
export const CopyText = Command.define("CopyText", {
  args: { rowId: Schema.String, text: Schema.String, version: Schema.Int },
  messages: [Message.CompletedCopy],
  execute: ({ rowId, text, version }) =>
    Effect.tryPromise(async () => {
      await navigator.clipboard.writeText(text);
    }).pipe(
      Effect.ignore,
      Effect.as(Message.CompletedCopy({ rowId, version }))
    ),
});

/** Ends a copy button's check after a moment. */
export const ExpireCopied = Command.define("ExpireCopied", {
  args: { version: Schema.Int },
  messages: [Message.ExpiredCopied],
  execute: ({ version }) =>
    Effect.sleep(COPIED_FOR).pipe(
      Effect.as(Message.ExpiredCopied({ version }))
    ),
});

const markHighlight = (element: Element, state: string): void => {
  if (element instanceof HTMLElement) {
    element.dataset.highlight = state;
  }
};

/**
 * Loads a code block's grammar when the block mounts (already loaded answers at once), and marks
 * the block `data-highlight` "loading", then "ready" or "failed".
 */
export const LoadHighlighting = Mount.define("LoadHighlighting", {
  args: { language: Schema.String },
  messages: [Message.LoadedLanguage, Message.FailedLanguage],
  execute: ({ element, language }) =>
    Effect.sync(() => {
      markHighlight(element, "loading");
    }).pipe(
      Effect.andThen(loadLanguage(language)),
      Effect.match({
        onSuccess: () => {
          markHighlight(element, "ready");

          return Message.LoadedLanguage({ language });
        },
        onFailure: () => {
          markHighlight(element, "failed");

          return Message.FailedLanguage({ language });
        },
      })
    ),
});
