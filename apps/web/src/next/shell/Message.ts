// The `next` shell's Messages, and the OutMessages it hands the root: an item for the outbox (a
// refresh's launch, a scratch turn or clear), a path to open, and a notice.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../../connection/Outbox.ts";

/** Everything the shell reacts to. */
export const Message = defineMessageUnion({
  /** A project's bubble on the rail. */
  ClickedProject: { projectId: ProjectId },
  /** The project thread's row or a managed thread's row. */
  ClickedThread: { threadId: ThreadId },
  /** The project has no project thread yet: start one from the composer. */
  ClickedStartProjectThread: {},
  ClickedUsage: {},
  ClickedSettings: {},
  ClickedOpenSheet: {},
  ClickedCloseSheet: {},

  LoadedFavicon: { projectId: ProjectId },
  FailedFavicon: { projectId: ProjectId },

  ClickedRefresh: {},
  ChangedRefreshText: { value: Schema.String },
  ClickedConfirmRefresh: {},
  ClickedCancelRefresh: {},
  /** The refresh's launch is minted: it goes to the outbox and the new thread opens. */
  PreparedRefresh: { item: OutboxItem, threadId: ThreadId },

  /** Cmd+J or Ctrl+J: show the scratch thread, or hide it. */
  PressedScratchShortcut: {},
  /** Escape while the overlay or the refresh confirm is open. */
  PressedEscape: {},
  ClickedScratchButton: {},
  ClickedCloseScratch: {},
  ChangedScratchDraft: { value: Schema.String },
  /** Enter without Shift in the scratch field: send. */
  PressedScratchEnter: {},
  ClickedSendScratch: {},
  /** The scratch turn is minted: a launch for the first message, a send after it. */
  PreparedScratchTurn: { item: OutboxItem, threadId: ThreadId },
  ClickedClearScratch: {},
  /** The clear is minted; the scratch thread is forgotten here and deleted by the brain. */
  PreparedScratchClear: { item: OutboxItem },
  /** The scratch thread this device held when it last saved, read at start. */
  LoadedScratch: { threadId: Schema.Option(ThreadId) },
  CompletedSaveScratch: {},
  /** A refresh or a scratch turn could not be prepared. */
  FailedPrepare: { message: Schema.String },
  ClickedDismissFailure: {},
});

export type Message = typeof Message.Type;

/** What the shell asks of the root. */
export const OutMessage = defineMessageUnion({
  /** Queue this item in the outbox, then open `navigateTo` when some. */
  RequestedOutbox: {
    item: OutboxItem,
    navigateTo: Schema.Option(Schema.String),
  },
  /** Open this path inside the app. */
  RequestedNavigate: { url: Schema.String },
});

export type OutMessage = typeof OutMessage.Type;
