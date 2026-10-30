// The transcript's subagent rows (plan 6C; surfaces note S4), for the `next` views only: a group of
// the children a parent spawned between two of its messages, placed after the work that spawned
// them, and at the top of a child's transcript the way back to its parent. Classic draws neither:
// the thread page passes the shell rows these rows read only when the `next` frame draws.
//
// The items come from the thread's own view (its spawn calls, briefs, registry and notes), so their
// keys never depend on the shell; each row's live state comes from the children's shell rows,
// which `subagentShellsOf` narrows to the open thread's children and keeps as one object while
// none of them changed, so an unrelated shell change redraws no row. The rows themselves are drawn
// by `next/timeline/SubagentRows.ts`, which the `next` chunk registers here when it loads, so the
// entry carries only this module.

import type { SubagentRequest } from "@cairn/client-logic/SubagentRollup";
import { pendingSubagentRequests } from "@cairn/client-logic/SubagentRollup";
import type { SubagentLink } from "@cairn/client-logic/SubagentRuntime";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Message } from "./Message.ts";
import type { ThreadUi } from "./Model.ts";
import type { ListItem } from "./Rows.ts";

/** A group of the children one step of the parent spawned, as one list item. */
export interface SubagentsItem {
  readonly kind: "subagents";
  /** `subagents:<first call id>`; also the id its open state is kept under. */
  readonly id: string;
  readonly createdAt: number;
  readonly links: ReadonlyArray<SubagentLink>;
  readonly expanded: boolean;
}

/** The way back from a subagent's transcript to its parent's, at the top of the list. */
export interface ParentLinkItem {
  readonly kind: "parent-link";
  readonly id: typeof PARENT_LINK_ID;
  readonly parentThreadId: ThreadId;
}

/** The way back's key. */
export const PARENT_LINK_ID = "subagent-parent";

/** A group's key. */
export const subagentGroupId = (callId: string): string =>
  `subagents:${callId}`;

/** What the rows read from the shell: the open thread's children and its parent's title. */
export interface SubagentShells {
  /** The open thread's children's rows, by thread id. */
  readonly children: ReadonlyMap<ThreadId, ThreadShell>;
  /** What each child's own descendants ask of the user. */
  readonly requests: ReadonlyMap<ThreadId, SubagentRequest>;
  /** The open thread's parent's title, when the open thread is a subagent with its parent's row. */
  readonly parentTitle: Option.Option<string>;
}

/** The rows' views, from the `next` chunk. */
export interface SubagentRowViews {
  /** `toggle` folds or opens the group: the transcript's own Message, made by its row view. */
  readonly group: (
    h: HtmlBuilder<Message>,
    item: SubagentsItem,
    shells: SubagentShells,
    toggle: Message
  ) => Html;
  readonly parentLink: (
    h: HtmlBuilder<Message>,
    item: ParentLinkItem,
    shells: SubagentShells
  ) => Html;
  /** The transcript's items with the subagent groups and the way back in place. */
  readonly items: (
    items: ReadonlyArray<ListItem>,
    state: Option.Option<ThreadViewState>,
    ui: ThreadUi
  ) => ReadonlyArray<ListItem>;
  /** Every key a subagent item of `state` can take. */
  readonly keys: (
    state: Option.Option<ThreadViewState>
  ) => ReadonlyArray<string>;
}

// Held outside the Model on purpose, as `next/FrameLoad.ts` holds the frame: a module is code, not
// state. One key, set once when the `next` chunk loads.
const registered = new Map<"views", SubagentRowViews>();

/** Registers the rows' views; the `next` chunk calls it as it loads. */
export const registerSubagentRowViews = (views: SubagentRowViews): void => {
  registered.set("views", views);
};

/** The rows' views, once the `next` chunk registered them. */
export const subagentRowViews = (): Option.Option<SubagentRowViews> =>
  Option.fromUndefinedOr(registered.get("views"));

// ---------------------------------------------------------------------------------------------
// Shell rows

interface ShellsMemo {
  readonly snapshot: ShellSnapshot;
  readonly threadId: string;
  readonly shells: SubagentShells;
}

const shellsMemo = new Map<"last", ShellsMemo>();

const sameRows = (
  a: ReadonlyMap<ThreadId, ThreadShell>,
  b: ReadonlyMap<ThreadId, ThreadShell>
): boolean =>
  a.size === b.size && [...a].every(([id, row]) => b.get(id) === row);

const sameRequests = (
  a: ReadonlyMap<ThreadId, SubagentRequest>,
  b: ReadonlyMap<ThreadId, SubagentRequest>
): boolean =>
  a.size === b.size && [...a].every(([id, request]) => b.get(id) === request);

const NO_SHELLS: SubagentShells = {
  children: new Map(),
  requests: new Map(),
  parentTitle: Option.none(),
};

const deriveShells = (
  snapshot: ShellSnapshot,
  threadId: string
): SubagentShells => {
  const children = new Map(
    snapshot.threads.flatMap((thread) =>
      Option.exists(
        thread.lineage,
        (lineage) => lineage.parentThreadId === threadId
      )
        ? [[thread.id, thread] as const]
        : []
    )
  );

  const all = pendingSubagentRequests(snapshot.threads);

  const requests = new Map(
    [...children.keys()].flatMap((id) => {
      const request = all.get(id);

      return request === undefined ? [] : [[id, request] as const];
    })
  );

  const open = snapshot.threads.find((thread) => thread.id === threadId);

  const parentTitle = Option.flatMap(
    Option.flatMap(Option.fromUndefinedOr(open), (thread) => thread.lineage),
    (lineage) =>
      Option.map(
        Option.fromUndefinedOr(
          snapshot.threads.find(
            (thread) => thread.id === lineage.parentThreadId
          )
        ),
        (parent) => parent.title
      )
  );

  return { children, requests, parentTitle };
};

/**
 * The shell rows the open thread's subagent rows read. The same object while its children's rows,
 * their requests and the parent's title are unchanged, so a row's lazy view keeps its drawing.
 */
export const subagentShellsOf = (
  shell: Option.Option<ShellSnapshot>,
  threadId: string
): SubagentShells => {
  if (Option.isNone(shell)) {
    return NO_SHELLS;
  }

  const last = shellsMemo.get("last");

  if (last?.snapshot === shell.value && last.threadId === threadId) {
    return last.shells;
  }

  const derived = deriveShells(shell.value, threadId);

  const shells =
    last !== undefined &&
    last.threadId === threadId &&
    sameRows(last.shells.children, derived.children) &&
    sameRequests(last.shells.requests, derived.requests) &&
    Option.getOrUndefined(last.shells.parentTitle) ===
      Option.getOrUndefined(derived.parentTitle)
      ? last.shells
      : derived;

  shellsMemo.set("last", { snapshot: shell.value, threadId, shells });

  return shells;
};

// ---------------------------------------------------------------------------------------------
// Items, placed by the `next` chunk (`next/timeline/SubagentItems.ts`) once it registered

/**
 * The transcript's items with the open thread's subagent groups and, for a subagent, the way back
 * to its parent; `items` itself until the `next` chunk registered its placing.
 */
export const withSubagentItems = (
  items: ReadonlyArray<ListItem>,
  state: Option.Option<ThreadViewState>,
  ui: ThreadUi
): ReadonlyArray<ListItem> =>
  Option.match(subagentRowViews(), {
    onNone: () => items,
    onSome: (views) => views.items(items, state, ui),
  });

/**
 * Every key a subagent item of `state` can take, for the list to keep their heights when the view
 * changes shape; none until the `next` chunk registered.
 */
export const subagentKeysOf = (
  state: Option.Option<ThreadViewState>
): ReadonlyArray<string> =>
  Option.match(subagentRowViews(), {
    onNone: () => [],
    onSome: (views) => views.keys(state),
  });

const NO_SUBAGENT_ROWS: Option.Option<SubagentShells> = Option.none();

const someShells = new WeakMap<SubagentShells, Option.Option<SubagentShells>>();

/**
 * What the thread page passes its transcript for the subagent rows: the open thread's shell rows
 * when the `next` frame draws, none on classic. One Option per shells object, so the page's lazy
 * view compares it by reference and keeps its drawing while nothing changed.
 */
export const subagentRowsInput = (
  next: boolean,
  shell: Option.Option<ShellSnapshot>,
  threadId: string
): Option.Option<SubagentShells> => {
  if (!next) {
    return NO_SUBAGENT_ROWS;
  }

  const shells = subagentShellsOf(shell, threadId);
  const known = someShells.get(shells);

  if (known !== undefined) {
    return known;
  }

  const input = Option.some(shells);

  someShells.set(shells, input);

  return input;
};
