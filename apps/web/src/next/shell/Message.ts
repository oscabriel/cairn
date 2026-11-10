// The `next` shell's Messages, and the OutMessages it hands the root: an item for the outbox (a
// refresh's launch, a scratch turn or clear), a path to open, and a new draft in a chosen project.
// The work panel's Messages are the shell's too: it is drawn beside the chat column, as the goal
// panel's are. The add-project picker's are the shell's too, and so are the "Previous" fold's,
// the project and thread menus' and their rename and remove dialogs'.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BrowseResult } from "@cairn/protocol/Projects";
import { PreviousThreadsPage, ThreadShell } from "@cairn/protocol/Shell";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../../connection/Outbox.ts";
import { ChildGroup, ManageAction, MenuTarget } from "./Model.ts";

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
  /** The rail's + bubble, or the hero's Add project: open the add-project picker. */
  ClickedAddProject: {},
  ChangedAddProjectFolder: { value: Schema.String },
  /** A folder in the listing, or Up: list that folder, and make it the one to add. */
  ClickedBrowseFolder: { path: Schema.String },
  ReceivedFolders: { request: Schema.Int, result: BrowseResult },
  FailedFolders: { request: Schema.Int, message: Schema.String },
  /** Add project, or Enter in the folder field. */
  SubmittedAddProject: {},
  ClickedCancelAddProject: {},
  /** The brain made the project for `folder`; the rail selects it once the shell shows it. */
  AddedProject: { folder: Schema.String },
  FailedAddProject: { folder: Schema.String, message: Schema.String },
  /** The added folder's project is in the shell: select it, as its bubble would. */
  FoundAddedProject: { projectId: ProjectId },

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
  /** A scratch turn could not be prepared. */
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
  /**
   * Stop on a workflow (6F): the whole of it, or one node when `nodeId` is some (the script sees
   * `null` for it). `key` is the work panel's Stopping key (`stopKeyOf`).
   */
  ClickedStopWorkflow: {
    threadId: ThreadId,
    workflowId: Schema.String,
    nodeId: Schema.Option(Schema.String),
  },
  StoppedWorkflow: { key: Schema.String },
  FailedStopWorkflow: { key: Schema.String, message: Schema.String },
  ClickedDismissWorkFailure: {},

  /** The "Previous" fold's header: show the project's earlier project threads, or hide them. */
  ClickedPreviousThreads: {},
  /** Show more: the next page of earlier project threads. */
  ClickedMorePreviousThreads: {},
  /** A page arrived; `more` when it follows the rows already shown. */
  ReceivedPreviousThreads: {
    request: Schema.Int,
    page: PreviousThreadsPage,
    more: Schema.Boolean,
  },
  FailedPreviousThreads: { request: Schema.Int, message: Schema.String },
  /** An earlier project thread's row: open it, read only. */
  ClickedPreviousThread: { thread: ThreadShell },
  /** The read-only bar of an earlier project thread: open its project's project thread. */
  ClickedOpenProjectThread: { projectId: ProjectId },

  /** A menu's button: open that menu, or close it when it is open. */
  ClickedMenu: { target: MenuTarget },
  /** A click outside the open menu. */
  ClickedCloseMenu: {},
  /** A menu item: open its rename or remove dialog. */
  ClickedManage: { action: ManageAction },
  ChangedManageText: { value: Schema.String },
  /** Save or Remove, or Enter in the name field. */
  ClickedConfirmManage: {},
  ClickedCancelManage: {},
  /** The brain took the rename or the remove. */
  CompletedManage: { action: ManageAction },
  FailedManage: { message: Schema.String },

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
