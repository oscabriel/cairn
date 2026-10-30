// The `next` shell's state (ADR 0040, plan look track L6): what the root told it last (the shell,
// the route, the connection, the clock), which project the rail has selected, the phone's sidebar
// sheet, which project favicons loaded, the refresh confirm, and the scratch thread's overlay. The
// rail, the project's sidebar list, the chat header and the scratch overlay all draw from it.

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
  failure: Option.none(),
};
