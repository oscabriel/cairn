// The `next` shell's Messages, and the OutMessages it hands the root: an item for the outbox (a
// refresh's launch, a scratch turn or clear), a path to open, and a new draft in a chosen project.
// The work panel's Messages are the shell's too: it is drawn beside the chat column, as the goal
// panel's are.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../../connection/Outbox.ts";
import { ChildGroup } from "./Model.ts";

/** Everything the shell reacts to. */
export const Message = defineMessageUnion({
  /** A project's bubble on the rail. */
  ClickedProject: { projectId: ProjectId },
  /** The project thread's row or a managed thread's row. */
  ClickedThread: { threadId: ThreadId },
  /** The project has no project thread yet: start one from the composer, in that project. */
  ClickedStartProjectThread: { projectId: ProjectId },
  /** A new draft is minted for the project's first thread: the root opens it in that project. */
  PreparedProjectDraft: { projectId: ProjectId, draftId: ThreadId },
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
  /** A field the overlay or the confirm opened with took focus, or was gone. */
  CompletedFocus: {},

  /** The header's work button: show the work panel, or hide it. */
  ClickedWork: {},
  ClickedCloseWork: {},
  ClickedPreviousChildren: {},
  ClickedMoreChildren: { group: ChildGroup },
  /** Stop on a child's row: its run stops, its queue and its own children stay. */
  ClickedStopChild: { threadId: ThreadId },
  StoppedChild: { threadId: ThreadId },
  FailedStopChild: { threadId: ThreadId, message: Schema.String },
  ClickedDismissWorkFailure: {},

  /** The header's goal chip: show the goal panel, or hide it. */
  ClickedGoal: {},
  ClickedCloseGoal: {},
  /** The user's own verdict on a criterion a user judge decides: met (`ok`) or not met. */
  ClickedMarkCriterion: {
    threadId: ThreadId,
    criterionId: Schema.String,
    ok: Schema.Boolean,
  },
  MarkedCriterion: { criterionId: Schema.String },
  FailedMarkCriterion: { criterionId: Schema.String, message: Schema.String },
  ClickedDismissGoalFailure: {},
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
  /**
   * Open the new draft `draftId` with `projectId` as its project, so the first message launches in
   * the project the rail picked (and becomes its project thread), never in another one.
   */
  RequestedProjectDraft: { projectId: ProjectId, draftId: ThreadId },
});

export type OutMessage = typeof OutMessage.Type;
