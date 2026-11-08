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
  /** The rows whose changed-files card the user opened past its one summary line. */
  expandedChangedFilesIds: Schema.Array(Schema.String),
  /**
   * The failed turn whose Retry already went to the outbox: its button hides and a second press
   * sends nothing. A later failed turn has another id, so it can be retried in its turn.
   */
  retriedTurnId: Schema.Option(Schema.String),
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
  /**
   * The latest page request's number, bumped by each request and by a switch of thread: only the
   * answer that carries it changes `history`, so a stale one cannot.
   */
  historyRequest: Schema.Int,
  /** The row whose copy button just copied. */
  copiedRowId: Schema.Option(Schema.String),
  copyVersion: Schema.Int,
  highlightedLanguages: Schema.Array(Schema.String),
  /** Counts long code blocks tokenized off the render; rows compare it, so they redraw with the tokens. */
  highlightedCode: Schema.Int,
  /**
   * The prompts (`promptKey`) of the sends to the shown thread waiting in the outbox, which every
   * tab shares and a reload keeps: a failed turn whose prompt is among them is being retried, so it
   * shows no Retry and a press sends nothing.
   */
  queuedPrompts: Schema.Array(Schema.String),
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
  expandedChangedFilesIds: [],
  retriedTurnId: Option.none(),
});

/** No thread yet. */
export const initial: Model = {
  threadId: Option.none(),
  ui: freshUi(Option.none()),
  saved: {},
  savedOrder: [],
  history: "idle",
  historyRequest: 0,
  copiedRowId: Option.none(),
  copyVersion: 0,
  highlightedLanguages: [],
  highlightedCode: 0,
  queuedPrompts: [],
};

/** What a prompt sends: its words, attachment ids and skills, as one comparable key. */
export const promptKey = (
  text: string,
  attachments: ReadonlyArray<string>,
  skillRefs: ReadonlyArray<string>
): string =>
  JSON.stringify([
    text,
    attachments,
    skillRefs.filter((skill) => skill.trim() !== ""),
  ]);

/** True while the list follows its end (new rows scroll into view). */
export const isFollowingEnd = (model: Model): boolean =>
  List.isFollowingEnd(model.ui.list);
