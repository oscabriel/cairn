// The shell's Messages, and the OutMessages it hands the root: an item for the outbox (a
// refresh's launch, a scratch clear), a visit for the outbox, a path to open, and a new
// draft in a chosen project. The clock, the platform, the visits, the favicon badge and the key
// bindings are the shell's (ADR 0050).
// The work panel's Messages are the shell's too: it is drawn beside the chat column, as the goal
// panel's are. The add-project picker's are the shell's too, and so are the "Previous" fold's,
// the project and thread menus' and their rename and remove dialogs'.

import type { KeybindingCommand } from "@cairn/client-logic/Keybindings";
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { BrowseResult } from "@cairn/protocol/Projects";
import { PreviousThreadsPage, ThreadShell } from "@cairn/protocol/Shell";
import { ShellCommand } from "@cairn/protocol/ShellCommands";
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { OutboxItem } from "../connection/Outbox.ts";
import { ChildGroup, ManageAction, ManagedGroup, MenuTarget } from "./Model.ts";

/** The commands of the key binding table, every one of which the shell answers. */
export const ShortcutCommand = Schema.Literals([
  "chat.new",
  "thread.previous",
  "thread.next",
] satisfies ReadonlyArray<KeybindingCommand>);

export type ShortcutCommand = typeof ShortcutCommand.Type;

/** Everything the shell reacts to. */
export const Message = defineMessageUnion({
  /** The clock Subscription's tick, or the clock read once at start. */
  Ticked: { nowMs: Schema.Finite },
  DetectedPlatform: { isMac: Schema.Boolean },
  CompletedSetBadge: {},
  /** The open thread's visit has its command id; it goes to the outbox. */
  MintedVisit: { command: ShellCommand },
  /** A key binding fired (`Keys.ts`). */
  PressedShortcut: { command: ShortcutCommand },
  /** New thread with no project thread to open: a new draft is minted, and the root opens it. */
  PreparedDraft: { draftId: ThreadId },

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
  /** Escape while a menu is open (an overlay's dialog takes its own Escape). */
  PressedEscape: {},
  ClickedScratchButton: {},
  /** Hide, Escape or a tap on the scrim of the scratch overlay. */
  ClickedCloseScratch: {},
  ClickedClearScratch: {},
  /** The clear is minted; the scratch thread is forgotten here and deleted by the brain. */
  PreparedScratchClear: { item: OutboxItem },
  /** The scratch thread this device held when it last saved, read at start. */
  LoadedScratch: { threadId: Schema.Option(ThreadId) },
  CompletedSaveScratch: {},

  /**
   * An overlay's dialog took the page or gave it back (focus, the trap, the scroll lock); whether
   * the overlay is open stays the shell's, so nothing changes.
   */
  SettledOverlay: {},
  /** The window crossed `lg`: the work and goal panels become columns, or sheets again. */
  ChangedWidth: { isWide: Schema.Boolean },

  /** The header's work button: show the work panel, or hide it. */
  ClickedWork: {},
  ClickedCloseWork: {},
  ClickedPreviousChildren: {},
  ClickedMoreChildren: { group: ChildGroup },
  /**
   * Stop on a child's row: the first press asks "Stop?" in place, the second stops its run (its
   * queue and its own children stay). Nothing undoes a stop, so it asks once (U-3).
   */
  ClickedStopChild: { threadId: ThreadId },
  /** A row's Stop lost focus: a "Stop?" it was asking lets go. */
  BlurredStop: {},
  /**
   * The pause after a row's first press ran out (`STOP_ASK_MS`): the "Stop?" asked under `key`
   * lets go. WebKit does not focus a tapped button, so no blur may ever come.
   */
  LapsedStop: { key: Schema.String },
  StoppedChild: { threadId: ThreadId },
  FailedStopChild: { threadId: ThreadId, message: Schema.String },
  /**
   * Stop on a workflow (6F): the whole of it, or one node when `nodeId` is some (the script sees
   * `null` for it). A node's row Stop asks "Stop?" on its first press, as a child's does (U-3).
   * `key` is the work panel's Stopping key (`stopKeyOf`).
   */
  ClickedStopWorkflow: {
    threadId: ThreadId,
    workflowId: Schema.String,
    nodeId: Schema.Option(Schema.String),
  },
  StoppedWorkflow: { key: Schema.String },
  FailedStopWorkflow: { key: Schema.String, message: Schema.String },
  ClickedDismissWorkFailure: {},

  /** The managed list's "Resting" fold: show the resting threads, or hide them (U-9). */
  ClickedRestingThreads: {},
  /** Show more under one of the managed list's groups. */
  ClickedMoreManaged: { group: ManagedGroup },

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
  /**
   * The brain's answer about a thread a page was opened on directly: the earlier project thread it
   * is, or none (not one, or the brain could not be asked).
   */
  LookedUpEarlierThread: {
    threadId: ThreadId,
    thread: Schema.Option(ThreadShell),
  },
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
  /** Queue this shell command (a visit) in the outbox. */
  RequestedDispatch: { command: ShellCommand },
  /**
   * Open the new draft `draftId` with `projectId` as its project, so the first message launches in
   * the project the rail picked (and becomes its project thread), never in another one.
   */
  RequestedProjectDraft: { projectId: ProjectId, draftId: ThreadId },
});

export type OutMessage = typeof OutMessage.Type;
