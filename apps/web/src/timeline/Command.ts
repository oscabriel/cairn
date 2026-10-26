// The transcript's effects: paging in older turns through `thread.history`, preparing a Retry for
// the outbox, the clipboard, and loading a code block's grammar when it mounts, then tokenizing a
// long block a slice at a time.

import { AttachmentId, EntryId, ThreadId } from "@cairn/protocol/Ids";
import { SendInput } from "@cairn/protocol/Thread";
import { Duration, Effect, Option, Schema, Stream } from "effect";
import { Command } from "foldkit";
import * as Mount from "foldkit/mount";

import { mintRequestId } from "../composer/Ids.ts";
import { CairnConnection, withBoundary } from "../connection/Connection.ts";
import { OutboxItem } from "../connection/Outbox.ts";
import { highlightStages } from "./markdown/Highlight.ts";
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
          withBoundary,
          Effect.match({
            onSuccess: (page) =>
              Message.LoadedEarlier({ threadId, before, page }),
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
      Effect.match({
        onSuccess: () =>
          Message.CompletedCopy({ rowId, version, copied: true }),
        onFailure: () =>
          Message.CompletedCopy({ rowId, version, copied: false }),
      })
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
 * Loads a code block's grammar when the block mounts (already loaded answers at once). `code` is
 * the settled text of a block too long to tokenize while rendering; it is tokenized into the
 * shared cache a slice at a time, each slice answered with `HighlightedCode` so the rows draw the
 * lines done so far. Marks the block `data-highlight` "loading", then "ready" or "failed".
 */
export const LoadHighlighting = Mount.defineStream("LoadHighlighting", {
  args: { language: Schema.String, code: Schema.Option(Schema.String) },
  messages: [
    Message.LoadedLanguage,
    Message.HighlightedCode,
    Message.FailedLanguage,
  ],
  execute: ({ code, element, language }) =>
    highlightStages(language, code).pipe(
      Stream.map((stage) =>
        stage === "loaded"
          ? Message.LoadedLanguage({ language })
          : Message.HighlightedCode({ language })
      ),
      Stream.onStart(
        Effect.sync(() => {
          markHighlight(element, "loading");
        })
      ),
      Stream.onEnd(
        Effect.sync(() => {
          markHighlight(element, "ready");
        })
      ),
      Stream.catchTag("HighlightLoadError", () =>
        Stream.fromEffect(
          Effect.sync(() => {
            markHighlight(element, "failed");

            return Message.FailedLanguage({ language });
          })
        )
      )
    ),
});
