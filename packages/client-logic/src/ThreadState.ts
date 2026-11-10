// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.ts
// (`resolveSidebarThreadStatus`, `resolveSidebarV2TopStatus`, `shouldShowSidebarV2Duration`), the row
// words in apps/web/src/components/Sidebar.tsx and the idle parking of background work in
// packages/client-runtime/src/state/models.ts (`shellRuntime`) at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the priority (a request for the user, approval over
// input, then busy work, then the latest run's failure, a usage limit reading as limited), a
// descendant's request shown on its ancestors, a finished run whose children still work reading
// "Waiting", and the top label falling back to "Woke", then "Done". Changed: one function over
// Cairn's shell row gives the state, its category from docs/golden/thread-states.md, the word and
// its tone, and the hold the banner shows; Cairn adds a brief ("Waiting for Go"), a child that
// asked its parent and queued input, and holds for a spent plan window and a Claude slot. Added: the
// one table of state to word, tone and mark every surface reads (`STATE_LOOKS`, U-14), and whether
// a run is live (`isRunLive`, C-11).
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import type { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadActivity, ThreadShell } from "@cairn/protocol/Shell";
import { Data, DateTime, Option } from "effect";

import { hasUnseenCompletion } from "./PresentThreadShell.ts";
import type { SubagentRequest } from "./SubagentRollup.ts";
import { threadWokeAt } from "./ThreadSettled.ts";

/** What a thread is doing, by priority: the one answer every surface reads. */
export type ThreadStatus =
  | "approval"
  | "go"
  | "input"
  | "asking-parent"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/**
 * The status's category, as `docs/golden/thread-states.md` names it: the brain or the arms work
 * (`active`), the user must answer (`waiting-on-you`), the thread cannot move on by itself
 * (`held`), nothing runs or asks (`resting`), the latest run failed (`failed`).
 */
export type ThreadCategory =
  | "active"
  | "waiting-on-you"
  | "held"
  | "resting"
  | "failed";

/** What a row's top label stands for: its status, else a snooze that ended, else unseen work. */
export type ThreadLabelKind = Exclude<ThreadStatus, "ready"> | "woke" | "done";

/**
 * A label's colour, by meaning: work under way (`info`), quiet waiting (`muted`), an approval
 * (`attention`), a question (`question`), something to look at (`warning`), a failure (`error`),
 * finished work (`success`).
 */
export type ThreadTone =
  | "info"
  | "muted"
  | "attention"
  | "question"
  | "warning"
  | "error"
  | "success";

/**
 * A state's mark: the glyph beside its word (the web's `StatusMark`). `needs` is the needs-you
 * dot, kept for the states that wait on the user, so nothing else reads as asking.
 */
export type StateMark =
  | "busy"
  | "needs"
  | "done"
  | "failed"
  | "todo"
  | "idle"
  | "info"
  | "warning";

/** A state as every surface draws it: its word, its tone and its mark. */
export interface StateLook {
  readonly word: string;
  readonly tone: ThreadTone;
  readonly mark: StateMark;
}

/**
 * Every state a surface names: a thread's labels, then a child at rest or never started, a brief
 * that ended without Go, a stop on its way, a hold, a subagent's step and a workflow node.
 */
export type StateName =
  | ThreadLabelKind
  | "idle"
  | "stopped"
  | "stopping"
  | "declined"
  | "sent-back"
  | "expired"
  | "cancelled"
  | "unstarted"
  | "waiting-for-slot"
  | "now"
  | "todo"
  | "queued"
  | "held"
  | "unknown"
  | "refused";

/**
 * The one table of state to word, tone and mark (U-14): the sidebar's rows, the chat header, the
 * hold banner, the parent banner, the work panel and the transcript's subagent rows all read it, so
 * one state has one name and one mark on a screen. Words are sentence case. A running workflow
 * node and a working child are one state, "Working".
 */
export const STATE_LOOKS: Readonly<Record<StateName, StateLook>> = {
  approval: { word: "Approval", tone: "attention", mark: "needs" },
  go: { word: "Waiting for Go", tone: "attention", mark: "needs" },
  input: { word: "Input", tone: "question", mark: "needs" },
  "asking-parent": { word: "Asked its parent", tone: "muted", mark: "idle" },
  working: { word: "Working", tone: "info", mark: "busy" },
  waiting: { word: "Waiting", tone: "muted", mark: "idle" },
  failed: { word: "Failed", tone: "error", mark: "failed" },
  // A spent plan window asks nothing of the user: its mark is the warning, not the needs-you dot.
  limited: { word: "Limited", tone: "warning", mark: "warning" },
  woke: { word: "Woke", tone: "warning", mark: "info" },
  done: { word: "Done", tone: "success", mark: "done" },
  idle: { word: "Idle", tone: "muted", mark: "idle" },
  stopped: { word: "Stopped", tone: "muted", mark: "idle" },
  stopping: { word: "Stopping", tone: "info", mark: "busy" },
  declined: { word: "Declined", tone: "muted", mark: "idle" },
  "sent-back": { word: "Sent back", tone: "muted", mark: "idle" },
  expired: { word: "Expired", tone: "muted", mark: "idle" },
  cancelled: { word: "Cancelled", tone: "muted", mark: "idle" },
  unstarted: { word: "Not started", tone: "error", mark: "failed" },
  "waiting-for-slot": {
    word: "Waiting for a Claude slot",
    tone: "info",
    mark: "busy",
  },
  now: { word: "Now", tone: "info", mark: "busy" },
  todo: { word: "To do", tone: "muted", mark: "todo" },
  queued: { word: "Queued", tone: "muted", mark: "todo" },
  held: { word: "Held", tone: "warning", mark: "warning" },
  unknown: { word: "Unknown", tone: "warning", mark: "warning" },
  refused: { word: "Refused", tone: "muted", mark: "idle" },
};

/** A label: what it stands for, and its look from `STATE_LOOKS`. */
export interface ThreadLabel extends StateLook {
  readonly kind: ThreadLabelKind;
}

const labelOfKind = (kind: ThreadLabelKind): ThreadLabel => ({
  kind,
  ...STATE_LOOKS[kind],
});

/** Every label's look. No status reaches the UI without one (invariant 16). */
export const THREAD_LABELS: Readonly<Record<ThreadLabelKind, ThreadLabel>> = {
  approval: labelOfKind("approval"),
  go: labelOfKind("go"),
  input: labelOfKind("input"),
  "asking-parent": labelOfKind("asking-parent"),
  working: labelOfKind("working"),
  waiting: labelOfKind("waiting"),
  failed: labelOfKind("failed"),
  limited: labelOfKind("limited"),
  woke: labelOfKind("woke"),
  done: labelOfKind("done"),
};

/** What holds the thread up beyond the user, most urgent first: the banner above an open thread. */
export type ThreadHold = Data.TaggedEnum<{
  Limited: { readonly resetsAt: ThreadShell["usageLimitResetAt"] };
  WaitingForSlot: { readonly threadId: ThreadId };
}>;

/** The holds' constructors and matcher. */
export const ThreadHold = Data.taggedEnum<ThreadHold>();

/** A hold's look, from `STATE_LOOKS`: a spent window is the same "Limited" its row says. */
export const HOLD_LABELS: Readonly<Record<ThreadHold["_tag"], StateLook>> = {
  Limited: STATE_LOOKS.limited,
  WaitingForSlot: STATE_LOOKS["waiting-for-slot"],
};

/** The fields of a row the state reads. */
export type ThreadStateRow = Pick<
  ThreadShell,
  | "id"
  | "activity"
  | "queueLength"
  | "lastErrorClass"
  | "usageLimitResetAt"
  | "waitingFor"
  | "pendingRuntimeRequest"
  | "subagents"
>;

/** Whether each activity has a run live; a new `ThreadActivity` literal fails the typecheck here. */
const RUN_LIVE: Readonly<Record<ThreadActivity, boolean>> = {
  idle: false,
  preparing: true,
  running: true,
  waiting: true,
  failed: false,
};

/** True while the thread's run is live: it holds an active run, or its activity is busy (C-11). */
export const isRunLive = (
  thread: Pick<ThreadShell, "activeRunId" | "activity">
): boolean => Option.isSome(thread.activeRunId) || RUN_LIVE[thread.activity];

const isUsageLimited = (
  thread: Pick<ThreadShell, "activity" | "lastErrorClass">
): boolean =>
  thread.activity === "failed" &&
  Option.contains(thread.lastErrorClass, "usage_limit");

/** What holds `thread` up beyond the user, if anything: a spent window, a slot. */
export const threadHold = (
  thread: Pick<
    ThreadShell,
    "id" | "activity" | "lastErrorClass" | "usageLimitResetAt" | "waitingFor"
  >
): Option.Option<ThreadHold> => {
  if (isUsageLimited(thread)) {
    return Option.some(
      ThreadHold.Limited({ resetsAt: thread.usageLimitResetAt })
    );
  }

  if (thread.waitingFor === "claude_slot") {
    return Option.some(ThreadHold.WaitingForSlot({ threadId: thread.id }));
  }

  return Option.none();
};

/** Children still working or asking keep a finished parent waiting on them. */
const hasChildrenAtWork = (thread: Pick<ThreadShell, "subagents">): boolean =>
  thread.subagents.working + thread.subagents.asking > 0;

/**
 * A thread's status. A request for the user first, its own or a descendant's (`subagentRequest`):
 * approval, then a brief's Go, then a question; then a child waiting on its parent's answer; then
 * busy work; then the latest run's failure (a spent plan window reads as limited); then a finished
 * run whose children still work, "Waiting".
 */
export const threadStatus = (
  thread: ThreadStateRow,
  subagentRequest: Option.Option<SubagentRequest>
): ThreadStatus => {
  const own = Option.map(thread.pendingRuntimeRequest, ({ kind }) => kind);

  if (
    Option.exists(
      own,
      (kind) =>
        kind === "tool-call" || kind === "executor-call" || kind === "criteria"
    ) ||
    Option.contains(subagentRequest, "approval")
  ) {
    return "approval";
  }

  if (Option.contains(own, "brief") || Option.contains(subagentRequest, "go")) {
    return "go";
  }

  if (Option.isSome(own) || Option.contains(subagentRequest, "input")) {
    return "input";
  }

  if (thread.waitingFor === "parent") {
    return "asking-parent";
  }

  if (
    thread.activity === "preparing" ||
    thread.activity === "running" ||
    (thread.activity === "idle" && thread.queueLength > 0)
  ) {
    return "working";
  }

  if (thread.activity === "waiting") {
    return "waiting";
  }

  if (thread.activity === "failed") {
    return Option.contains(thread.lastErrorClass, "usage_limit")
      ? "limited"
      : "failed";
  }

  return hasChildrenAtWork(thread) ? "waiting" : "ready";
};

const STATUS_CATEGORIES: Readonly<Record<ThreadStatus, ThreadCategory>> = {
  approval: "waiting-on-you",
  go: "waiting-on-you",
  input: "waiting-on-you",
  "asking-parent": "held",
  working: "active",
  waiting: "active",
  failed: "failed",
  limited: "held",
  ready: "resting",
};

/** The category of a status, held when a hold stands behind it (a Claude slot under "Working"). */
const categoryOf = (
  status: ThreadStatus,
  hold: Option.Option<ThreadHold>
): ThreadCategory => {
  const category = STATUS_CATEGORIES[status];

  return category === "active" && Option.isSome(hold) ? "held" : category;
};

/**
 * True when a snooze ended (early or on time) after the user last looked, and the thread was not
 * settled since: the row says "Woke".
 */
export const isThreadWoke = (thread: ThreadShell, now: DateTime.Utc): boolean =>
  !Option.contains(thread.settledOverride, "settled") &&
  Option.exists(threadWokeAt(thread, now), (wokeAt) =>
    Option.match(thread.lastVisitedAt, {
      onNone: () => true,
      onSome: (visitedAt) => DateTime.isLessThan(visitedAt, wokeAt),
    })
  );

/** Everything a surface shows for a thread: its status, category, label, hold and unseen marks. */
export interface ThreadState {
  readonly status: ThreadStatus;
  readonly category: ThreadCategory;
  /** The row's top label; none shows the row's age instead. */
  readonly label: Option.Option<ThreadLabel>;
  /** The banner above the open thread. */
  readonly hold: Option.Option<ThreadHold>;
  /** A run finished after the user last looked. */
  readonly isUnread: boolean;
  /** A snooze ended after the user last looked. */
  readonly isWoke: boolean;
  /** Only working rows show how long they have been at it. */
  readonly showsDuration: boolean;
}

/** What else the state reads beyond the row: the time, and the descendants' requests. */
export interface ThreadStateContext {
  readonly now: DateTime.Utc;
  /** What the thread's descendants ask of the user (`pendingSubagentRequests`). */
  readonly subagentRequest: Option.Option<SubagentRequest>;
}

/** The label: the status, else "Woke" after a snooze ended unseen, else "Done" when unseen. */
const labelOf = (
  status: ThreadStatus,
  isUnread: boolean,
  isWoke: boolean
): Option.Option<ThreadLabel> => {
  if (status !== "ready") {
    return Option.some(THREAD_LABELS[status]);
  }

  if (isWoke) {
    return Option.some(THREAD_LABELS.woke);
  }

  return isUnread ? Option.some(THREAD_LABELS.done) : Option.none();
};

/** The one thread-state function: a row and its descendants' requests to everything shown. */
export const threadState = (
  thread: ThreadShell,
  context: ThreadStateContext
): ThreadState => {
  const status = threadStatus(thread, context.subagentRequest);
  const hold = threadHold(thread);
  const isUnread = hasUnseenCompletion(thread);
  const isWoke = isThreadWoke(thread, context.now);

  return {
    status,
    category: categoryOf(status, hold),
    label: labelOf(status, isUnread, isWoke),
    hold,
    isUnread,
    isWoke,
    showsDuration: status === "working",
  };
};
