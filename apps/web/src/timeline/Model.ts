// The transcript's state: which thread it shows, that thread's scroll list and the folds, groups
// and long prompts the user opened, the same for recently shown threads (so switching back
// restores the scroll position and what was open), the history paging state, the copy feedback
// and the code grammars loaded so far. The rows themselves are derived from the page's thread view
// (Rows.ts), never stored here.

import { Option, Schema } from "effect";

import * as List from "./list/Model.ts";

/** What the transcript remembers about one thread while it is not on screen. */
export const ThreadUi = Schema.Struct({
  list: List.Model,
  expandedTurnIds: Schema.Array(Schema.String),
  expandedWorkGroupIds: Schema.Array(Schema.String),
  expandedUserMessageIds: Schema.Array(Schema.String),
});

export type ThreadUi = typeof ThreadUi.Type;

/** Where paging in older turns stands. */
export const HistoryState = Schema.Literals(["idle", "loading", "failed"]);

export type HistoryState = typeof HistoryState.Type;

/** The transcript's Model. */
export const Model = Schema.Struct({
  threadId: Schema.Option(Schema.String),
  ui: ThreadUi,
  /** Other threads' state, most recently left last. */
  saved: Schema.Record(Schema.String, ThreadUi),
  savedOrder: Schema.Array(Schema.String),
  history: HistoryState,
  /** The row whose copy button just copied. */
  copiedRowId: Schema.Option(Schema.String),
  copyVersion: Schema.Int,
  highlightedLanguages: Schema.Array(Schema.String),
  /** Counts long code blocks tokenized off the render; rows compare it, so they redraw with the tokens. */
  highlightedCode: Schema.Int,
});

export type Model = typeof Model.Type;

/** How many other threads keep their scroll position and open folds. */
export const SAVED_THREAD_LIMIT = 20;

/** The scroll list's element id for a thread: each thread mounts its own list. */
export const listIdOf = (threadId: Option.Option<string>): string =>
  `timeline-${Option.getOrElse(threadId, () => "none").replaceAll(/[^A-Za-z0-9_-]/gu, "_")}`;

/** A thread shown for the first time: at its end, following new rows, nothing open. */
export const freshUi = (threadId: Option.Option<string>): ThreadUi => ({
  list: List.init(listIdOf(threadId)),
  expandedTurnIds: [],
  expandedWorkGroupIds: [],
  expandedUserMessageIds: [],
});

/** No thread yet. */
export const initial: Model = {
  threadId: Option.none(),
  ui: freshUi(Option.none()),
  saved: {},
  savedOrder: [],
  history: "idle",
  copiedRowId: Option.none(),
  copyVersion: 0,
  highlightedLanguages: [],
  highlightedCode: 0,
};

/** True while the list follows its end (new rows scroll into view). */
export const isFollowingEnd = (model: Model): boolean =>
  List.isFollowingEnd(model.ui.list);
