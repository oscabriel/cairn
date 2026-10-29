import { AttachmentId, EntryId } from "@cairn/protocol/Ids";
import { HistoryPage } from "@cairn/protocol/Thread";
// The transcript's Messages and the OutMessages it hands to the thread page.
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../connection/Outbox.ts";
import { Message as ListMessage } from "./list/Message.ts";

/** Everything the transcript reacts to. */
export const Message = defineMessageUnion({
  GotListMessage: { message: ListMessage },
  ToggledTurnFold: { turnId: Schema.String },
  ToggledWorkGroup: { groupId: Schema.String },
  ToggledUserMessage: { rowId: Schema.String },
  ClickedScrollToEnd: {},
  ClickedLoadEarlier: { threadId: Schema.String, before: EntryId },
  /** A history page, with the cursor it was asked from. */
  LoadedEarlier: {
    threadId: Schema.String,
    before: EntryId,
    page: HistoryPage,
  },
  FailedEarlier: { threadId: Schema.String },
  /** Retry on a failed turn's error: its prompt goes out again. */
  ClickedRetry: {
    threadId: Schema.String,
    text: Schema.String,
    attachments: Schema.Array(AttachmentId),
    skillRefs: Schema.Array(Schema.String),
  },
  PreparedRetry: { item: OutboxItem },
  ClickedCopy: { rowId: Schema.String, text: Schema.String },
  /** A copy ended; `copied` is false when the browser refused the clipboard write. */
  CompletedCopy: {
    rowId: Schema.String,
    version: Schema.Int,
    copied: Schema.Boolean,
  },
  ExpiredCopied: { version: Schema.Int },
  LoadedLanguage: { language: Schema.String },
  /** A long code block's tokens are in the shared cache: its grammar is loaded and rows redraw. */
  HighlightedCode: { language: Schema.String },
  FailedLanguage: { language: Schema.String },
  /** The working timer's Mount started; it writes its own text. */
  MountedTimer: {},
  /** A changed-files card asked for its turn's diff, at a file or at the top. */
  ClickedOpenDiff: { turn: Schema.Int, path: Schema.Option(Schema.String) },
});

export type Message = typeof Message.Type;

/** What the transcript asks of the thread page. */
export const OutMessage = defineMessageUnion({
  /** An older page from `thread.history`, to put in front of the view (`prependHistory`). */
  ReceivedHistory: { before: EntryId, page: HistoryPage },
  /** A turn to queue in the outbox (Retry). */
  RequestedSend: { item: OutboxItem },
  /** The diff panel, opened on a turn (and a file in it). */
  RequestedDiff: { turn: Schema.Int, path: Schema.Option(Schema.String) },
});

export type OutMessage = typeof OutMessage.Type;
