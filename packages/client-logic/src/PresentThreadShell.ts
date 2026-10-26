// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/{models.ts
// (presentThreadShell, shellRuntime, resolveThreadWorkingStartedAt), threadShell.ts (the
// presentation's use of the wire row)} at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the
// presentation answers "is it working, since when, does it need me, is there news" from server
// fields alone, so every device agrees. Changed: Cairn's `activity` replaces t3code's run status
// union, times stay DateTime values, environments, subagents and pull requests are gone.
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

import type { ThreadShell } from "@cairn/protocol/Shell";
import { DateTime, Option } from "effect";

/** The latest run of a thread, as the sidebar and the hero read it. */
export interface RunSummary {
  readonly requestedAt: Option.Option<DateTime.Utc>;
  readonly startedAt: Option.Option<DateTime.Utc>;
  readonly completedAt: Option.Option<DateTime.Utc>;
}

/** A thread row with the questions every surface asks of it already answered. */
export interface ThreadPresentation {
  /** The wire row this presentation was made from; compare it by identity to skip work. */
  readonly source: ThreadShell;
  /** Preparing or running: the model or a tool is busy right now. */
  readonly isWorking: boolean;
  /** When the current work began: the active run's start, else when it was requested. */
  readonly workingStartedAt: Option.Option<DateTime.Utc>;
  /** The latest run, when the thread has had one. */
  readonly latestRun: Option.Option<RunSummary>;
  /** A tool call is held for the user's approval. */
  readonly hasPendingApproval: boolean;
  /** The agent asked the user a question or a sign-in is needed. */
  readonly hasPendingUserInput: boolean;
  /** A run finished after the user last looked at the thread. */
  readonly hasUnseenCompletion: boolean;
  /** pi-durable parked at least one task; the row offers a retry. */
  readonly isParked: boolean;
  /** The latest run failed. */
  readonly isFailed: boolean;
  /** Waiting for a free Claude slot, not for the user. */
  readonly isWaitingForClaudeSlot: boolean;
}

const isAfter = (left: DateTime.Utc, right: DateTime.Utc) =>
  DateTime.isGreaterThan(left, right);

/**
 * True when a run completed after the user's last visit. A thread never visited counts as unseen
 * once any run completed.
 */
export const hasUnseenCompletion = (thread: ThreadShell): boolean =>
  Option.match(thread.latestRunCompletedAt, {
    onNone: () => false,
    onSome: (completedAt) =>
      Option.match(thread.lastVisitedAt, {
        onNone: () => true,
        onSome: (visitedAt) => isAfter(completedAt, visitedAt),
      }),
  });

/** Presents one wire row. Pure: the same row always gives an equal presentation. */
export const presentThreadShell = (thread: ThreadShell): ThreadPresentation => {
  const isWorking =
    thread.activity === "preparing" || thread.activity === "running";

  const hasRun =
    Option.isSome(thread.latestRunRequestedAt) ||
    Option.isSome(thread.latestRunStartedAt) ||
    Option.isSome(thread.latestRunCompletedAt);

  const requestKind = Option.map(
    thread.pendingRuntimeRequest,
    (request) => request.kind
  );

  return {
    source: thread,
    isWorking,
    workingStartedAt:
      isWorking || thread.activity === "waiting"
        ? Option.orElse(
            thread.latestRunStartedAt,
            () => thread.latestRunRequestedAt
          )
        : Option.none(),
    latestRun: hasRun
      ? Option.some({
          requestedAt: thread.latestRunRequestedAt,
          startedAt: thread.latestRunStartedAt,
          completedAt: thread.latestRunCompletedAt,
        })
      : Option.none(),
    hasPendingApproval: Option.exists(
      requestKind,
      (kind) => kind === "executor-call" || kind === "tool-call"
    ),
    hasPendingUserInput: Option.exists(
      requestKind,
      (kind) => kind === "user-input" || kind === "sign-in"
    ),
    hasUnseenCompletion: hasUnseenCompletion(thread),
    isParked: thread.activity === "parked" || thread.parkedTaskIds.length > 0,
    isFailed: thread.activity === "failed",
    isWaitingForClaudeSlot: thread.waitingFor === "claude_slot",
  };
};
