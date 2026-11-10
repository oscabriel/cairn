// The `next` shell's state (ADR 0040, plan look track L6): what the root told it last (the shell,
// the route, the connection), the clock, the platform, the visits it sent and the favicon's number
// (the classic sidebar's state until ADR 0050 moved them here), which project the rail has selected, the phone's sidebar
// sheet, which project favicons loaded, the refresh confirm, the scratch thread's overlay, and the
// work panel's open state. The rail, the project's sidebar list, the chat header, the scratch
// overlay and the work panel all draw from it, and so does the goal panel (plan 6H): the open
// thread's criteria and the user's marks on its own. The sidebar's managed list folds its resting
// rows and pages both groups, as the work panel does (U-9). The rail's + bubble opens the add-project
// picker, whose folder, once added, the rail selects when the shell shows its project. The
// selected project's earlier project threads (its "Previous" fold, ADR 0048), the project and
// thread menus and the rename and remove dialogs they open are the shell's too.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ModelDefaults } from "@cairn/protocol/Models";
import { BrowseResult } from "@cairn/protocol/Projects";
import {
  PreviousThreadsCursor,
  ShellSnapshot,
  ThreadShell,
} from "@cairn/protocol/Shell";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { AppRoute } from "../../Route.ts";
import { VisitState } from "../../shell/Visited.ts";

/** What the root tells the shell after every change. */
export const ShellContext = Schema.Struct({
  shell: Schema.Option(ShellSnapshot),
  route: AppRoute,
  /** The connection's client exists, so a call can be made. */
  hasClient: Schema.Boolean,
  /** The shell is current on this connection: a visit is sent only then. */
  isLive: Schema.Boolean,
  /** The server's model defaults, once `session.hello` answered: a scratch launch uses them. */
  defaults: Schema.Option(ModelDefaults),
  /**
   * On the hero and a draft's page, the project the draft launches in (`draftProject`), so the rail
   * and the list show the project the hero names; none on every other page.
   */
  draftProjectId: Schema.Option(ProjectId),
});

export type ShellContext = typeof ShellContext.Type;

/** How a project's favicon request ended: drawn, or none to draw (its letter shows). */
export const FaviconState = Schema.Literals(["loaded", "missing"]);

export type FaviconState = typeof FaviconState.Type;

/** The open refresh confirm: the project thread it replaces and the new thread's first message. */
export const RefreshConfirm = Schema.Struct({
  projectId: ProjectId,
  replaces: ThreadId,
  text: Schema.String,
  /** The launch is being prepared; the confirm takes no second click. */
  isSending: Schema.Boolean,
  /** Why the last Refresh did nothing, drawn on the confirm, which stays open with its message. */
  failure: Schema.Option(Schema.String),
});

export type RefreshConfirm = typeof RefreshConfirm.Type;

/**
 * The scratch thread's overlay: shown or hidden, and the thread it holds. What is typed in it is the
 * composer's, which serves the overlay while it is shown (U-16).
 */
export const ScratchState = Schema.Struct({
  isOpen: Schema.Boolean,
  /** The scratch thread, once the first message launched it; kept while the overlay is hidden. */
  threadId: Schema.Option(ThreadId),
  /** The clear is being prepared. */
  isBusy: Schema.Boolean,
});

export type ScratchState = typeof ScratchState.Type;

/** Which of the work panel's two child groups a "Show more" grows. */
export const ChildGroup = Schema.Literals(["active", "previous"]);

export type ChildGroup = typeof ChildGroup.Type;

/**
 * The work panel (lineage and steps): shown or hidden, the "Previous" group open, how many rows
 * each child group shows, the row Stop pressed once and asking "Stop?", and the children whose
 * Stop was asked and has not yet shown on their row.
 */
export const WorkState = Schema.Struct({
  isOpen: Schema.Boolean,
  isPreviousOpen: Schema.Boolean,
  shownActive: Schema.Int,
  shownPrevious: Schema.Int,
  /**
   * The row whose Stop was pressed once and now asks "Stop?" (U-3): a child's thread id, or a
   * node's `stopKeyOf`. A second press stops it; pressing another row's Stop, leaving the control
   * or closing the panel lets it go.
   */
  armedStop: Schema.Option(Schema.String),
  stopping: Schema.Array(ThreadId),
  /** Workflows and nodes a Stop was asked of and not yet answered, by `stopKeyOf`. */
  stoppingWork: Schema.Array(Schema.String),
  /** Why the last Stop did not reach Cairn. */
  failure: Schema.Option(Schema.String),
});

export type WorkState = typeof WorkState.Type;

/** Rows a child group shows before its first "Show more" (t3code's lineage window). */
export const FIRST_CHILD_ROWS = 6;

/** The work panel closed, its groups at their first page. */
export const initialWork: WorkState = {
  isOpen: false,
  isPreviousOpen: false,
  shownActive: FIRST_CHILD_ROWS,
  shownPrevious: FIRST_CHILD_ROWS,
  armedStop: Option.none(),
  stopping: [],
  stoppingWork: [],
  failure: Option.none(),
};

/** Which of the sidebar's two managed groups a "Show more" grows. */
export const ManagedGroup = Schema.Literals(["live", "resting"]);

export type ManagedGroup = typeof ManagedGroup.Type;

/**
 * The sidebar's list of the threads the project thread manages, in the work panel's shape (U-9):
 * the resting fold open, and how many rows each group shows (six, then twelve more a press).
 */
export const ManagedListState = Schema.Struct({
  isRestingOpen: Schema.Boolean,
  shownLive: Schema.Int,
  shownResting: Schema.Int,
});

export type ManagedListState = typeof ManagedListState.Type;

/** The managed list at its first page, its resting fold closed. */
export const initialManagedList: ManagedListState = {
  isRestingOpen: false,
  shownLive: FIRST_CHILD_ROWS,
  shownResting: FIRST_CHILD_ROWS,
};

/** The work panel's Stopping key of a whole workflow, or of one of its nodes. */
export const stopKeyOf = (
  workflowId: string,
  nodeId: Option.Option<string>
): string =>
  Option.match(nodeId, {
    onNone: () => workflowId,
    onSome: (node) => `${workflowId}/${node}`,
  });

/**
 * The goal panel (plan 6H): shown or hidden, the criteria whose mark is on its way to Cairn, and
 * why the last mark did not reach it.
 */
export const GoalPanelState = Schema.Struct({
  isOpen: Schema.Boolean,
  /** Criterion ids of marks sent and not yet answered; their buttons take no second tap. */
  marking: Schema.Array(Schema.String),
  failure: Schema.Option(Schema.String),
});

export type GoalPanelState = typeof GoalPanelState.Type;

/** The goal panel closed, with no mark out. */
export const initialGoalPanel: GoalPanelState = {
  isOpen: false,
  marking: [],
  failure: Option.none(),
};

/** The rows a page of earlier project threads answered with, and the cursor of the next page. */
export const PreviousRows = Schema.Struct({
  threads: Schema.Array(ThreadShell),
  next: Schema.Option(PreviousThreadsCursor),
});

export type PreviousRows = typeof PreviousRows.Type;

/**
 * The sidebar's "Previous" fold (ADR 0048): the selected project's earlier project threads, read
 * from the brain (archived rows stay out of the shell stream) whenever the project or its project
 * thread changes. `key` names the project and project thread the rows are for.
 */
export const PreviousState = Schema.Struct({
  key: Schema.Option(Schema.String),
  projectId: Schema.Option(ProjectId),
  isOpen: Schema.Boolean,
  /** None until the first page answers. */
  rows: Schema.Option(PreviousRows),
  isLoading: Schema.Boolean,
  /** The number of the page asked last; an answer to an older one is dropped. */
  request: Schema.Int,
  failure: Schema.Option(Schema.String),
  /**
   * The earlier project thread opened last, from the fold or as the brain answered for a page
   * opened on it directly, read only: its header and its page read it (as they read the fold's rows).
   */
  opened: Schema.Option(ThreadShell),
  /**
   * The thread last asked of the brain (`shell.earlierThread`): one a page was opened on that
   * neither the shell nor the fold holds. It is asked once per route, and again on a reconnect.
   */
  askedAbout: Schema.Option(ThreadId),
});

export type PreviousState = typeof PreviousState.Type;

/** The fold before anything was read. */
export const initialPrevious: PreviousState = {
  key: Option.none(),
  projectId: Option.none(),
  isOpen: false,
  rows: Option.none(),
  isLoading: false,
  request: 0,
  failure: Option.none(),
  opened: Option.none(),
  askedAbout: Option.none(),
};

/** How many earlier project threads one page of the fold reads. */
export const PREVIOUS_PAGE = 20;

/** Which menu is open: the selected project's, or the open thread's (from the chat header). */
export const MenuTarget = defineTaggedUnion({
  Project: { projectId: ProjectId },
  Thread: { threadId: ThreadId },
});

export type MenuTarget = typeof MenuTarget.Type;

/** What a menu item asks for: renaming or removing a project, or renaming a thread. */
export const ManageAction = defineTaggedUnion({
  RenameProject: { projectId: ProjectId },
  RemoveProject: { projectId: ProjectId },
  RenameThread: { threadId: ThreadId },
});

export type ManageAction = typeof ManageAction.Type;

/** The open rename or remove dialog: its action, the name typed, and its call on its way. */
export const ManageState = Schema.Struct({
  action: ManageAction,
  /** The new name; unused by a remove. */
  text: Schema.String,
  isSending: Schema.Boolean,
  /** Why the last try did not go, drawn on the dialog, which stays open. */
  failure: Schema.Option(Schema.String),
});

export type ManageState = typeof ManageState.Type;

/** The add-project picker's folder listing: on its way, shown, or refused. */
export const FolderListing = defineTaggedUnion({
  Loading: { path: Schema.Option(Schema.String) },
  Loaded: { result: BrowseResult },
  Failed: { message: Schema.String },
});

export type FolderListing = typeof FolderListing.Type;

/**
 * The open add-project picker: the folder typed or browsed to, the listing beside it and the number
 * of the request it waits for (from the shell's `folderRequests`, so a slow answer for a folder the
 * user left, in this picker or one closed before, is dropped), the home folder once the first
 * listing named it (a typed `~` is read against it), and the create on its way or refused.
 */
export const AddProjectState = Schema.Struct({
  folder: Schema.String,
  listing: FolderListing,
  request: Schema.Int,
  home: Schema.Option(Schema.String),
  /** The folder whose create is on its way; only its answer reaches this picker. */
  adding: Schema.Option(Schema.String),
  failure: Schema.Option(Schema.String),
});

export type AddProjectState = typeof AddProjectState.Type;

/**
 * A visit sent and not yet shown on its thread's row: while one waits for the open thread no other
 * is planned, so a tick past the throttle never queues another behind it. It is dropped once the
 * row shows it, or after `PENDING_VISIT_TTL_MS`.
 */
export const PendingVisit = Schema.Struct({
  threadId: ThreadId,
  at: Schema.DateTimeUtc,
  /** When it was sent, in epoch milliseconds. */
  sentAtMs: Schema.Finite,
});

export type PendingVisit = typeof PendingVisit.Type;

/** How long a visit may wait for the brain to show it before it is forgotten. */
export const PENDING_VISIT_TTL_MS = 15_000;

/** The id of the rename dialog's name field, which takes focus when it opens (`-cancel` for a remove). */
export const MANAGE_TEXT_ID = "manage-text";

/** The id of the refresh confirm's field, which takes focus when it opens. */
export const REFRESH_TEXT_ID = "refresh-text";

/** The `next` shell's Model. */
export const Model = Schema.Struct({
  context: ShellContext,
  /** The shell's update has run once, asking for the scratch thread this device saved. */
  started: Schema.Boolean,
  /** The time ages are computed at, in epoch milliseconds, from the clock Subscription. */
  nowMs: Schema.Finite,
  /** An Apple platform, where `mod` is Command and key hints say so. */
  isMac: Schema.Boolean,
  /**
   * The window is `lg` or wider: the work and goal panels are columns beside the chat, not modal
   * sheets over it (`Subscription.ts` follows the width).
   */
  isWide: Schema.Boolean,
  /** The last visit this page sent, for its throttle (`shell/Visited.ts`). */
  visits: VisitState,
  pendingVisits: Schema.Array(PendingVisit),
  /** The favicon's number: the roots that need the user (`needsYouCount`). */
  badgeCount: Schema.Int,
  /** The project the user picked on the rail; none follows the open thread. */
  selectedProjectId: Schema.Option(ProjectId),
  /** The phone's sidebar sheet is open. */
  isSheetOpen: Schema.Boolean,
  /** How each project's favicon request ended, by project id; absent while it loads. */
  favicons: Schema.Record(Schema.String, FaviconState),
  refresh: Schema.Option(RefreshConfirm),
  scratch: ScratchState,
  work: WorkState,
  managedList: ManagedListState,
  goal: GoalPanelState,
  addProject: Schema.Option(AddProjectState),
  /** Folder listings asked so far, across every opening of the picker; each carries its number. */
  folderRequests: Schema.Int,
  /** The folder just added: the rail selects its project once the shell shows it. */
  awaitedFolder: Schema.Option(Schema.String),
  previous: PreviousState,
  menu: Schema.Option(MenuTarget),
  manage: Schema.Option(ManageState),
});

export type Model = typeof Model.Type;

/** The context before the root has told the shell anything. */
export const emptyContext: ShellContext = {
  shell: Option.none(),
  route: AppRoute.Hero(),
  hasClient: false,
  isLive: false,
  defaults: Option.none(),
  draftProjectId: Option.none(),
};

/** A shell with nothing in it yet. */
export const initial: Model = {
  context: emptyContext,
  started: false,
  nowMs: 0,
  isMac: false,
  isWide: false,
  visits: Option.none(),
  pendingVisits: [],
  badgeCount: 0,
  selectedProjectId: Option.none(),
  isSheetOpen: false,
  favicons: {},
  refresh: Option.none(),
  scratch: {
    isOpen: false,
    threadId: Option.none(),
    isBusy: false,
  },
  work: initialWork,
  managedList: initialManagedList,
  goal: initialGoalPanel,
  addProject: Option.none(),
  folderRequests: 0,
  awaitedFolder: Option.none(),
  previous: initialPrevious,
  menu: Option.none(),
  manage: Option.none(),
};
