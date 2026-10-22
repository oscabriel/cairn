import { AttachmentId, EntryId } from "@cairn/protocol/Ids";
import { HistoryPage } from "@cairn/protocol/Thread";
// The transcript's Messages and the OutMessages it hands to the thread page.
import * as VirtualList from "@foldkit/ui/virtualList";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../connection/Outbox.ts";

/** Everything the transcript reacts to. */
export const Message = defineMessageUnion({
  GotListMessage: { message: VirtualList.Message },
  ToggledTurnFold: { turnId: Schema.String },
  ToggledWorkGroup: { groupId: Schema.String },
  ToggledUserMessage: { rowId: Schema.String },
  ClickedScrollToEnd: {},
  ClickedLoadEarlier: { threadId: Schema.String, before: EntryId },
  LoadedEarlier: { threadId: Schema.String, page: HistoryPage },
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
  CompletedCopy: { rowId: Schema.String, version: Schema.Int },
  ExpiredCopied: { version: Schema.Int },
  LoadedLanguage: { language: Schema.String },
  FailedLanguage: { language: Schema.String },
  /** The working timer's Mount started; it writes its own text. */
  MountedTimer: {},
  /** The end-follow Mount started. */
  MountedFollowEnd: {},
  /** A changed-files card asked for its turn's diff, at a file or at the top. */
  ClickedOpenDiff: { turn: Schema.Int, path: Schema.Option(Schema.String) },
});

export type Message = typeof Message.Type;

/** What the transcript asks of the thread page. */
export const OutMessage = defineMessageUnion({
  /** An older page from `thread.history`, to put in front of the view (`prependHistory`). */
  ReceivedHistory: { page: HistoryPage },
  /** A turn to queue in the outbox (Retry). */
  RequestedSend: { item: OutboxItem },
  /** The diff panel, opened on a turn (and a file in it). */
  RequestedDiff: { turn: Schema.Int, path: Schema.Option(Schema.String) },
});

export type OutMessage = typeof OutMessage.Type;
