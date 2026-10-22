// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/shellReducer.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: items at or below the snapshot's sequence are
// ignored, updates replace whole rows in place, an unchanged row keeps its object so views skip it,
// and a new snapshot reuses every unchanged row. Changed: no repository-identity enrichment, no pull
// request links and one location (an archived thread leaves the shell as a removal); state is an
// Option rather than null.
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
import type {
  ShellDelta,
  ShellSnapshot,
  ShellStreamItem,
} from "@cairn/protocol/Shell";
import { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Match, Option, Schema } from "effect";

const sameThreadShell = Schema.toEquivalence(ThreadShell);

const sameProjectShell = Schema.toEquivalence(ProjectShell);

const upsertById = <T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
  same: (left: T, right: T) => boolean
): ReadonlyArray<T> => {
  const index = items.findIndex((candidate) => candidate.id === item.id);

  if (index === -1) {
    return [...items, item];
  }

  const existing = items[index];

  if (existing !== undefined && same(existing, item)) {
    return items;
  }

  return items.map((candidate, candidateIndex) =>
    candidateIndex === index ? item : candidate
  );
};

/**
 * Takes a new snapshot, keeping the previous object for every row that did not change, so a view
 * keyed by row identity re-renders only what changed.
 */
export const reuseUnchangedThreadShells = (
  previous: Option.Option<ShellSnapshot>,
  next: ShellSnapshot
): ShellSnapshot => {
  if (Option.isNone(previous) || previous.value.threads.length === 0) {
    return next;
  }

  const previousById = new Map(
    previous.value.threads.map((thread) => [thread.id, thread] as const)
  );

  let changed = false;

  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);

    if (prior === undefined || !sameThreadShell(prior, thread)) {
      return thread;
    }

    changed = true;

    return prior;
  });

  return changed ? { ...next, threads } : next;
};

/**
 * Applies one update to a snapshot. An item at or below the snapshot's sequence is already in it
 * and is ignored; otherwise the snapshot moves to the item's sequence.
 */
export const applyShellStreamEvent = (
  snapshot: ShellSnapshot,
  event: ShellDelta
): ShellSnapshot => {
  if (event.sequence <= snapshot.snapshotSequence) {
    return snapshot;
  }

  return Match.valueTags(event, {
    ProjectUpdated: ({ project, sequence }) => ({
      ...snapshot,
      projects: upsertById(snapshot.projects, project, sameProjectShell),
      snapshotSequence: sequence,
    }),
    ProjectRemoved: ({ projectId, sequence }) => ({
      ...snapshot,
      projects: snapshot.projects.filter((project) => project.id !== projectId),
      snapshotSequence: sequence,
    }),
    ThreadUpdated: ({ sequence, thread }) => ({
      ...snapshot,
      threads: upsertById(snapshot.threads, thread, sameThreadShell),
      snapshotSequence: sequence,
    }),
    ThreadRemoved: ({ sequence, threadId }) => ({
      ...snapshot,
      threads: snapshot.threads.filter((thread) => thread.id !== threadId),
      snapshotSequence: sequence,
    }),
  });
};

/**
 * Applies any shell stream item to the client's state: a snapshot replaces it (reusing unchanged
 * rows), the completion marker leaves it as it is, and an update before the first snapshot is
 * dropped because there is nothing to apply it to.
 */
export const applyShellStreamItem = (
  state: Option.Option<ShellSnapshot>,
  item: ShellStreamItem
): Option.Option<ShellSnapshot> =>
  Match.valueTags(item, {
    Snapshot: ({ snapshot }) =>
      Option.some(reuseUnchangedThreadShells(state, snapshot)),
    Synchronized: () => state,
    ProjectUpdated: (event) =>
      Option.map(state, (snapshot) => applyShellStreamEvent(snapshot, event)),
    ProjectRemoved: (event) =>
      Option.map(state, (snapshot) => applyShellStreamEvent(snapshot, event)),
    ThreadUpdated: (event) =>
      Option.map(state, (snapshot) => applyShellStreamEvent(snapshot, event)),
    ThreadRemoved: (event) =>
      Option.map(state, (snapshot) => applyShellStreamEvent(snapshot, event)),
  });

/** The sequence to resume after on reconnect: the snapshot's, or none before the first snapshot. */
export const shellCursor = (
  state: Option.Option<ShellSnapshot>
): Option.Option<number> =>
  Option.map(state, (snapshot) => snapshot.snapshotSequence);
