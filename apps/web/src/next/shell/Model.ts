// The `next` shell's state (ADR 0040, plan look track L6): what the root told it last (the shell,
// the route, the connection, the clock), which project the rail has selected, the phone's sidebar
// sheet, which project favicons loaded, the refresh confirm, the scratch thread's overlay, and the
// work panel's open state. The rail, the project's sidebar list, the chat header, the scratch
// overlay and the work panel all draw from it, and so does the goal panel (plan 6H): the open
// thread's criteria and the user's marks on its own.

import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import { ModelDefaults } from "@cairn/protocol/Models";
import { ShellSnapshot } from "@cairn/protocol/Shell";
import { Option, Schema } from "effect";

import { AppRoute } from "../../Route.ts";

/** What the root tells the shell after every change. */
export const ShellContext = Schema.Struct({
  shell: Schema.Option(ShellSnapshot),
  route: AppRoute,
  /** The connection's client exists, so a call can be made. */
  hasClient: Schema.Boolean,
  /** The server's model defaults, once `session.hello` answered: a scratch launch uses them. */
  defaults: Schema.Option(ModelDefaults),
  /** The time ages are computed at, in epoch milliseconds (the sidebar's clock). */
  nowMs: Schema.Finite,
  /** An Apple platform, where the scratch thread's key hint reads Cmd. */
  isMac: Schema.Boolean,
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
});

export type RefreshConfirm = typeof RefreshConfirm.Type;

/** The scratch thread's overlay: shown or hidden, the thread it holds, and what is typed in it. */
export const ScratchState = Schema.Struct({
  isOpen: Schema.Boolean,
  /** The scratch thread, once the first message launched it; kept while the overlay is hidden. */
  threadId: Schema.Option(ThreadId),
  draft: Schema.String,
  /** A turn or the clear is being prepared. */
  isBusy: Schema.Boolean,
});

export type ScratchState = typeof ScratchState.Type;

/** Which of the work panel's two child groups a "Show more" grows. */
export const ChildGroup = Schema.Literals(["active", "previous"]);

export type ChildGroup = typeof ChildGroup.Type;

/**
 * The work panel (lineage and steps): shown or hidden, the "Previous" group open, how many rows
 * each child group shows, and the children whose Stop was asked and has not yet shown on their row.
 */
export const WorkState = Schema.Struct({
  isOpen: Schema.Boolean,
  isPreviousOpen: Schema.Boolean,
  shownActive: Schema.Int,
  shownPrevious: Schema.Int,
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
  stopping: [],
  stoppingWork: [],
  failure: Option.none(),
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

/** The `next` shell's Model. */
export const Model = Schema.Struct({
  context: ShellContext,
  /** The shell's update has run once, asking for the scratch thread this device saved. */
  started: Schema.Boolean,
  /** The project the user picked on the rail; none follows the open thread. */
  selectedProjectId: Schema.Option(ProjectId),
  /** The phone's sidebar sheet is open. */
  isSheetOpen: Schema.Boolean,
  /** How each project's favicon request ended, by project id; absent while it loads. */
  favicons: Schema.Record(Schema.String, FaviconState),
  refresh: Schema.Option(RefreshConfirm),
  scratch: ScratchState,
  work: WorkState,
  goal: GoalPanelState,
  /** Why the last refresh or scratch turn could not be prepared. */
  failure: Schema.Option(Schema.String),
});

export type Model = typeof Model.Type;

/** The context before the root has told the shell anything. */
export const emptyContext: ShellContext = {
  shell: Option.none(),
  route: AppRoute.Hero(),
  hasClient: false,
  defaults: Option.none(),
  nowMs: 0,
  isMac: false,
};

/** A shell with nothing in it yet. */
export const initial: Model = {
  context: emptyContext,
  started: false,
  selectedProjectId: Option.none(),
  isSheetOpen: false,
  favicons: {},
  refresh: Option.none(),
  scratch: {
    isOpen: false,
    threadId: Option.none(),
    draft: "",
    isBusy: false,
  },
  work: initialWork,
  goal: initialGoalPanel,
  failure: Option.none(),
};
