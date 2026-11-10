// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/threadShell.ts
// (`isChildRunLive`, `subagentRequest`, `pendingSubagentRequestsByThread`, `childThreadInputsTitle`
// and the descendant walk in `childThreadInputsAtomFamily`) and apps/web/src/components/
// Sidebar.logic.ts (`isSidebarSubagentThread`, `resolveSidebarRowThreadId`,
// `filterSidebarV2VisibleThreads`) and apps/web/src/components/ChatView.tsx (`childInputBannerItem`)
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: a child's request reaches every ancestor with
// approval over input, a request counts only while the child's run is live, a broken or looping
// chain stops the walk, a subagent's row resolves to its nearest ancestor that is not one, and the
// parent's banner names its asking descendants unless the parent asks the user itself. Changed: Cairn's shell rows (`lineage` is an Option, the run is
// live while `activeRunId` is set or `activity` is busy), a brief or a criteria proposal counts with
// no live run because no run holds one (ADR 0030), a brief rolls up as Go (between approval and
// input) so its ancestors say what its own row says, one environment, plain functions instead of
// atoms.
// Not ported: provider-native subagents, forks, the atom caches and their reference stability.
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
import type { RuntimeRequestKind } from "@cairn/protocol/Policy";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";

import type { ThreadLabel } from "./ThreadState.ts";
import { isRunLive, THREAD_LABELS } from "./ThreadState.ts";

/**
 * What a descendant's pending request asks of the user, as its ancestors show it: an approval, a
 * brief's Go, or input. Each reads on the ancestors in the word the child's own row says (U-14).
 */
export type SubagentRequest = "approval" | "go" | "input";

/** Which request an ancestor shows when several descendants ask: approval, then Go, then input. */
const REQUEST_RANK: Readonly<Record<SubagentRequest, number>> = {
  approval: 2,
  go: 1,
  input: 0,
};

/** The fields of a row the rollup reads. */
export type RollupRow = Pick<
  ThreadShell,
  | "id"
  | "title"
  | "lineage"
  | "activity"
  | "activeRunId"
  | "pendingRuntimeRequest"
>;

/** True for a subagent's row, which the sidebar hides (ADR 0028). */
export const isSubagentThread = (
  thread: Pick<ThreadShell, "lineage">
): boolean =>
  Option.exists(
    thread.lineage,
    (lineage) => lineage.relationshipToParent === "subagent"
  );

/** The parent of a subagent's row; none for a row the user opened. */
const parentOf = (
  thread: Pick<ThreadShell, "lineage">
): Option.Option<ThreadId> =>
  Option.flatMap(thread.lineage, (lineage) =>
    lineage.relationshipToParent === "subagent"
      ? Option.some(lineage.parentThreadId)
      : Option.none()
  );

/** Requests no run holds: they wait for the user whether or not the child runs (ADR 0030). */
const HELD_BY_NO_RUN: ReadonlySet<RuntimeRequestKind> = new Set([
  "brief",
  "criteria",
]);

/** A brief waits for Go, a question or a sign-in for input, and every other kind for approval. */
export const requestOfKind = (kind: RuntimeRequestKind): SubagentRequest => {
  if (kind === "brief") {
    return "go";
  }

  return kind === "user-input" || kind === "sign-in" ? "input" : "approval";
};

/** What a subagent's own pending request asks its ancestors to show, if it counts. */
export const subagentRequestOf = (
  thread: RollupRow
): Option.Option<SubagentRequest> => {
  if (!isSubagentThread(thread)) {
    return Option.none();
  }

  return Option.flatMap(thread.pendingRuntimeRequest, ({ kind }) =>
    HELD_BY_NO_RUN.has(kind) || isRunLive(thread)
      ? Option.some(requestOfKind(kind))
      : Option.none()
  );
};

const indexById = <T extends RollupRow>(
  threads: ReadonlyArray<T>
): ReadonlyMap<ThreadId, T> =>
  new Map(threads.map((thread) => [thread.id, thread] as const));

/**
 * Each ancestor of a subagent with a counting request, mapped to what it should show: approval
 * wins over Go, and Go over input, from any descendant. A thread with no asking descendant is
 * absent.
 */
export const pendingSubagentRequests = (
  threads: ReadonlyArray<RollupRow>
): ReadonlyMap<ThreadId, SubagentRequest> => {
  const requests = new Map<ThreadId, SubagentRequest>();
  const byId = indexById(threads);

  for (const child of threads) {
    const request = subagentRequestOf(child);

    if (Option.isNone(request)) {
      continue;
    }

    const seen = new Set<ThreadId>([child.id]);
    let parent = parentOf(child);

    while (Option.isSome(parent) && !seen.has(parent.value)) {
      const parentId = parent.value;

      seen.add(parentId);

      const shown = requests.get(parentId);

      if (
        shown === undefined ||
        REQUEST_RANK[request.value] > REQUEST_RANK[shown]
      ) {
        requests.set(parentId, request.value);
      }

      parent = Option.flatMap(
        Option.fromUndefinedOr(byId.get(parentId)),
        parentOf
      );
    }
  }

  return requests;
};

/** What `threadId` shows for its descendants' requests, if any ask. */
export const subagentRequestFor = (
  requests: ReadonlyMap<ThreadId, SubagentRequest>,
  threadId: ThreadId
): Option.Option<SubagentRequest> =>
  Option.fromUndefinedOr(requests.get(threadId));

/**
 * Every subagent under `threadId`, nearest first (children, then theirs); a loop is walked once.
 */
export const subagentDescendants = <
  T extends Pick<ThreadShell, "id" | "lineage">,
>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>
): ReadonlyArray<T> => {
  const children = new Map<ThreadId, Array<T>>();

  for (const thread of threads) {
    const parent = parentOf(thread);

    if (Option.isSome(parent)) {
      const siblings = children.get(parent.value);

      if (siblings === undefined) {
        children.set(parent.value, [thread]);
      } else {
        siblings.push(thread);
      }
    }
  }

  const seen = new Set<ThreadId>([threadId]);
  const pending: Array<ThreadId> = [threadId];
  const found: Array<T> = [];

  for (const parent of pending) {
    for (const child of children.get(parent) ?? []) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        pending.push(child.id);
        found.push(child);
      }
    }
  }

  return found;
};

/**
 * The descendants of `threadId` whose requests count, nearest first: what the parent's banner
 * lists ("Subagent · Approval").
 */
export const childrenAsking = <T extends RollupRow>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>
): ReadonlyArray<T> =>
  subagentDescendants(threadId, threads).filter((child) =>
    Option.isSome(subagentRequestOf(child))
  );

/**
 * What an asking child's own row says, from the one state table: "Waiting for Go" for a brief,
 * "Input" for a question or a sign-in, else "Approval" (`threadStatus`'s own-request order).
 */
export const askingLabelOf = (child: RollupRow): ThreadLabel =>
  Option.match(child.pendingRuntimeRequest, {
    onNone: () => THREAD_LABELS.approval,
    onSome: ({ kind }) => THREAD_LABELS[requestOfKind(kind)],
  });

/** The one label every asking child shares, if they share one. */
export const sharedAskingLabel = (
  children: ReadonlyArray<RollupRow>
): Option.Option<ThreadLabel> => {
  const kinds = new Set(children.map((child) => askingLabelOf(child).kind));
  const [first] = children;

  return kinds.size === 1 && first !== undefined
    ? Option.some(askingLabelOf(first))
    : Option.none();
};

/**
 * The banner's title over the asking children, in the rows' own words (U-14): "Subagent ·
 * Approval", "2 subagents · Waiting for Go", and "3 subagents need you" when they ask for
 * different things (each child's word then follows its name).
 */
export const childInputsTitle = (
  children: ReadonlyArray<RollupRow>
): string => {
  const subject =
    children.length === 1 ? "Subagent" : `${children.length} subagents`;

  return Option.match(sharedAskingLabel(children), {
    onNone: () => `${subject} need you`,
    onSome: (label) => `${subject} · ${label.word}`,
  });
};

/**
 * The sidebar row that stands for `threadId`: a subagent has none, so its nearest ancestor that is
 * not a subagent. A broken chain (a missing parent, a loop) resolves to the thread itself, which
 * then matches no row.
 */
export const sidebarRowThreadId = (
  threadId: ThreadId,
  threads: ReadonlyArray<Pick<ThreadShell, "id" | "lineage">>
): ThreadId => {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const visited = new Set<ThreadId>();
  let current = Option.fromUndefinedOr(byId.get(threadId));

  while (Option.isSome(current) && isSubagentThread(current.value)) {
    const thread = current.value;
    const parent = parentOf(thread);

    if (Option.isNone(parent) || visited.has(thread.id)) {
      return threadId;
    }

    visited.add(thread.id);
    current = Option.fromUndefinedOr(byId.get(parent.value));
  }

  return Option.match(current, {
    onNone: () => threadId,
    onSome: (thread) => thread.id,
  });
};

/** The banner over a parent's composer while its descendants ask the user. */
export interface ParentBanner<T> {
  /** "Subagent · Approval", "2 subagents · Input", "2 subagents need you". */
  readonly title: string;
  /** Every descendant asking, nearest first; each is named, and opens its thread. */
  readonly children: ReadonlyArray<T>;
  /** The first of them, which the banner's action (Open) opens. */
  readonly first: T;
  /** What the first asks for, as its ancestors' rows roll it up. */
  readonly request: SubagentRequest;
  /** The label every asking child shares; none when they ask for different things. */
  readonly label: Option.Option<ThreadLabel>;
}

/**
 * The parent banner of `threadId` (t3code's `childInputBannerItem`, ChatView.tsx): its asking
 * descendants, unless the thread asks the user something itself, whose card then has the
 * composer's lane. None when no descendant asks.
 */
export const parentBannerOf = <T extends RollupRow>(
  threadId: ThreadId,
  threads: ReadonlyArray<T>
): Option.Option<ParentBanner<T>> => {
  const thread = threads.find((each) => each.id === threadId);

  if (thread === undefined || Option.isSome(thread.pendingRuntimeRequest)) {
    return Option.none();
  }

  const children = childrenAsking(threadId, threads);
  const [first] = children;

  if (first === undefined) {
    return Option.none();
  }

  return Option.map(subagentRequestOf(first), (request) => ({
    title: childInputsTitle(children),
    children,
    first,
    request,
    label: sharedAskingLabel(children),
  }));
};
