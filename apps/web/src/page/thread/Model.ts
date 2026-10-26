// The thread page's state: which thread it shows, the connection it may stream over (told by the
// root on every change), and the client's copy of the thread's projected view.

import { ThreadId } from "@cairn/protocol/Ids";
import { ConversationView, Entry } from "@cairn/protocol/Thread";
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import * as Diff from "../../diff/Model.ts";
import * as Timeline from "../../timeline/Model.ts";

/** The client's copy of one thread's view; the Model form of client-logic's `ThreadViewState`. */
export const ThreadViewModel = Schema.Struct({
  seq: Schema.Int,
  view: ConversationView,
  entriesOffset: Schema.Int,
  hasMoreHistory: Schema.Boolean,
  older: Schema.Array(Entry),
});

export type ThreadViewModel = typeof ThreadViewModel.Type;

/** Where the page's thread stream is. */
export const ThreadStatus = defineTaggedUnion({
  /** Waiting for the first snapshot of the current subscription. */
  Loading: {},
  /** The view is current. */
  Ready: {},
  /** The brain has no such thread, and no launch of it is on its way. */
  Missing: {},
  /** The stream failed for another reason; it is opened again after a short wait. */
  Failed: { message: Schema.String },
});

export type ThreadStatus = typeof ThreadStatus.Type;

/** The page's Model. */
export const Model = Schema.Struct({
  /** The thread the route names, when its id is well formed. */
  threadId: Schema.Option(ThreadId),
  /** The root connection's epoch; every stream belongs to one. */
  epoch: Schema.Int,
  /** True while the root's client for `epoch` exists. */
  hasClient: Schema.Boolean,
  /**
   * True while the thread's launch is on its way: the outbox holds it, or the shell row is
   * `preparing`. A NotFound then means "not yet", so the page keeps loading and subscribes again.
   */
  launching: Schema.Boolean,
  /** Bumped to open a fresh subscription (and so a fresh snapshot) on the same connection. */
  watch: Schema.Int,
  /** Resubscribes since the last snapshot; picks the next wait (`Command.ts`). */
  retries: Schema.Int,
  status: ThreadStatus,
  view: Schema.Option(ThreadViewModel),
  /** The transcript: its list, open folds and per-thread scroll memory. */
  timeline: Timeline.Model,
  /** The diff panel (closed until a changed-files card opens it). */
  diff: Diff.Model,
  /** Where the panel's lazily loaded view is (`DiffPanel.ts`). */
  diffPanel: Schema.Literals(["idle", "loading", "loaded", "failed"]),
});

export type Model = typeof Model.Type;

/** A page with no thread and no connection yet. */
export const initial: Model = {
  threadId: Option.none(),
  epoch: 0,
  hasClient: false,
  launching: false,
  watch: 0,
  retries: 0,
  status: ThreadStatus.Loading(),
  view: Option.none(),
  timeline: Timeline.initial,
  diff: Diff.initial,
  diffPanel: "idle",
};
