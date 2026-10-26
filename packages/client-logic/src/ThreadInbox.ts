// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadInbox.ts at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: what "working" means for the inbox (busy and not
// blocked on the user) and the two inbox orders (by return, by send), newest first with id
// tie-breaks. Changed: Cairn's shell rows (`activity` instead of runtime and run status, no plan
// mode or subagents), and the return time a client observed is passed in as an `Option`. The return
// tracker for the Working shelf is not ported: the shelf is off by default in t3code and Cairn does
// not build it (plan D27).
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
import { Array, DateTime, Option, Order } from "effect";

/** True while the agent is busy on the thread and nothing waits on the user. */
export const isThreadWorking = (
  thread: Pick<ThreadShell, "activity" | "pendingRuntimeRequest">
): boolean =>
  Option.isNone(thread.pendingRuntimeRequest) &&
  (thread.activity === "preparing" ||
    thread.activity === "running" ||
    thread.activity === "waiting");

const millisOr = (time: Option.Option<DateTime.Utc>): number =>
  Option.match(time, { onNone: () => 0, onSome: DateTime.toEpochMillis });

const newestFirst = <T extends { readonly id: string }>(
  threads: ReadonlyArray<T>,
  stamp: (thread: T) => number
): Array<T> => {
  const stamped = threads.map((thread) => ({ thread, at: stamp(thread) }));

  type Stamped = (typeof stamped)[number];

  return Array.sort(
    stamped,
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (entry: Stamped) => entry.at),
      Order.mapInput(Order.String, (entry: Stamped) => entry.thread.id)
    )
  ).map((entry) => entry.thread);
};

/** The fields the inbox orders by. */
export type InboxSortInput = Pick<
  ThreadShell,
  | "id"
  | "createdAt"
  | "unsettledAt"
  | "latestRunRequestedAt"
  | "latestRunCompletedAt"
>;

/**
 * The inbox by return: newest of creation, un-settle, the latest run's request and completion,
 * and the time this client saw the thread stop working.
 */
export const sortInboxThreadsByReturn = <T extends InboxSortInput>(
  threads: ReadonlyArray<T>,
  observedReturnAt: (thread: T) => Option.Option<number> = () => Option.none()
): Array<T> =>
  newestFirst(threads, (thread) =>
    Math.max(
      DateTime.toEpochMillis(thread.createdAt),
      millisOr(thread.unsettledAt),
      millisOr(thread.latestRunRequestedAt),
      millisOr(thread.latestRunCompletedAt),
      Option.getOrElse(observedReturnAt(thread), () => 0)
    )
  );

/** The fields the working order reads. */
export type WorkingSortInput = Pick<
  ThreadShell,
  "id" | "createdAt" | "latestUserMessageAt" | "latestRunRequestedAt"
>;

/**
 * Working threads by the last message the user sent (a run the agent started on its own does not
 * move the row); a thread with no user message falls back to its latest run's request.
 */
export const sortWorkingThreadsBySend = <T extends WorkingSortInput>(
  threads: ReadonlyArray<T>
): Array<T> =>
  newestFirst(threads, (thread) =>
    Math.max(
      DateTime.toEpochMillis(thread.createdAt),
      millisOr(
        Option.orElse(
          thread.latestUserMessageAt,
          () => thread.latestRunRequestedAt
        )
      )
    )
  );
