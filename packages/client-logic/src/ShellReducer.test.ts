// Ported from github.com/pingdotgg/t3code, packages/client-runtime/src/state/shellReducer.test.ts
// at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92: the cases that apply to Cairn's shell (in-place
// updates, identity kept for unchanged rows, stale items ignored, project updates and removals,
// removals, snapshot reuse). Repository-identity and pull-request cases have no Cairn counterpart.
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
import { ProjectId, ThreadId } from "@cairn/protocol/Ids";
import {
  ProjectRemovedItem,
  ProjectShell,
  ProjectUpdatedItem,
  ShellSnapshotItem,
  ShellSynchronizedItem,
  ThreadRemovedItem,
  ThreadShell,
  ThreadUpdatedItem,
} from "@cairn/protocol/Shell";
import type { ShellSnapshot, ShellStreamItem } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import {
  applyShellStreamEvent,
  applyShellStreamItem,
  reuseUnchangedThreadShells,
  shellCursor,
} from "./ShellReducer.ts";

const at = DateTime.makeUnsafe("2026-10-22T08:00:00.000Z");

const threadIds = {
  a: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d01"),
  b: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d02"),
  c: ThreadId.make("0199f0c2-6a4e-7d4c-9a6b-2b9a1f3c4d03"),
};

const project = ProjectShell.make({
  id: ProjectId.make("prj_cairn"),
  title: "cairn",
  kind: "folder",
  workspaceRoot: "/home/me/Developer/projects/cairn",
  repository: Option.some("oscabriel/cairn"),
  defaultModel: Option.none(),
  createdAt: at,
  updatedAt: at,
});

const thread = (id: ThreadId, title = "A thread") =>
  ThreadShell.make({
    id,
    projectId: project.id,
    title,
    provider: "claude-bridge",
    modelId: "claude-haiku-5-5",
    thinkingLevel: "medium",
    runtimeMode: "full-access",
    branch: Option.none(),
    worktreePath: Option.none(),
    activity: "idle",
    activeRunId: Option.none(),
    latestRunRequestedAt: Option.none(),
    latestRunStartedAt: Option.none(),
    latestRunCompletedAt: Option.none(),
    queueLength: 0,
    lastError: Option.none(),
    lastErrorClass: Option.none(),
    usageLimitResetAt: Option.none(),
    waitingFor: "none",
    pendingRuntimeRequest: Option.none(),
    latestVisibleMessage: Option.none(),
    latestUserMessageAt: Option.none(),
    createdAt: at,
    updatedAt: at,
    archivedAt: Option.none(),
    settledOverride: Option.none(),
    settledAt: Option.none(),
    unsettledAt: Option.none(),
    snoozedUntil: Option.none(),
    snoozedAt: Option.none(),
    pinnedAt: Option.none(),
    pinOrderKey: Option.none(),
    activeOrderKey: Option.none(),
    autoSettleDisabledAt: Option.none(),
    lastVisitedAt: Option.none(),
    parkedTaskIds: [],
  });

const follow = (
  state: Option.Option<ShellSnapshot>,
  items: ReadonlyArray<ShellStreamItem>
): Option.Option<ShellSnapshot> => {
  let current = state;

  for (const item of items) {
    current = applyShellStreamItem(current, item);
  }

  return current;
};

const snapshot = (overrides: Partial<ShellSnapshot> = {}): ShellSnapshot => ({
  snapshotSequence: 0,
  projects: [project],
  threads: [],
  ...overrides,
});

describe(applyShellStreamEvent, () => {
  it("updates a thread in place without moving its siblings", () => {
    const threads = [
      thread(threadIds.a),
      thread(threadIds.b),
      thread(threadIds.c),
    ];

    const event = ThreadUpdatedItem.make({
      sequence: 1,
      thread: { ...thread(threadIds.b), title: "Streaming" },
    });

    const next = applyShellStreamEvent(snapshot({ threads }), event);

    assert.deepStrictEqual(
      next.threads.map((row) => row.id),
      [threadIds.a, threadIds.b, threadIds.c]
    );
    assert.strictEqual(next.threads[0], threads[0]);
    assert.strictEqual(next.threads[1], event.thread);
    assert.strictEqual(next.threads[2], threads[2]);
  });

  it("keeps the thread list and object when an update changes nothing", () => {
    const threads = [thread(threadIds.a), thread(threadIds.b)];

    const next = applyShellStreamEvent(
      snapshot({ threads }),
      ThreadUpdatedItem.make({
        sequence: 1,
        thread: { ...thread(threadIds.b) },
      })
    );

    assert.strictEqual(next.threads, threads);
    assert.strictEqual(next.snapshotSequence, 1);
  });

  it("appends a thread it has not seen", () => {
    const next = applyShellStreamEvent(
      snapshot({ threads: [thread(threadIds.a)] }),
      ThreadUpdatedItem.make({ sequence: 1, thread: thread(threadIds.b) })
    );

    assert.deepStrictEqual(
      next.threads.map((row) => row.id),
      [threadIds.a, threadIds.b]
    );
  });

  it("ignores stale project updates without changing the snapshot", () => {
    const current = snapshot({ snapshotSequence: 4 });

    for (const sequence of [3, 4]) {
      const next = applyShellStreamEvent(
        current,
        ProjectUpdatedItem.make({
          sequence,
          project: { ...project, title: "Stale title" },
        })
      );

      assert.strictEqual(next, current);
      assert.strictEqual(next.projects[0]?.title, "cairn");
    }
  });

  it("applies project updates and removals", () => {
    const updated = applyShellStreamEvent(
      snapshot(),
      ProjectUpdatedItem.make({
        sequence: 1,
        project: { ...project, title: "Updated" },
      })
    );

    assert.strictEqual(updated.projects[0]?.title, "Updated");
    assert.strictEqual(updated.snapshotSequence, 1);

    const removed = applyShellStreamEvent(
      updated,
      ProjectRemovedItem.make({ sequence: 2, projectId: project.id })
    );

    assert.deepStrictEqual(removed.projects, []);
    assert.strictEqual(removed.snapshotSequence, 2);
  });

  it("removes a thread", () => {
    const next = applyShellStreamEvent(
      snapshot({ threads: [thread(threadIds.a), thread(threadIds.b)] }),
      ThreadRemovedItem.make({ sequence: 3, threadId: threadIds.a })
    );

    assert.deepStrictEqual(
      next.threads.map((row) => row.id),
      [threadIds.b]
    );
    assert.strictEqual(next.snapshotSequence, 3);
  });
});

describe(reuseUnchangedThreadShells, () => {
  it("keeps the previous object for an unchanged row", () => {
    const previous = snapshot({
      threads: [thread(threadIds.a), thread(threadIds.b)],
    });

    const next = snapshot({
      snapshotSequence: 5,
      threads: [{ ...thread(threadIds.a) }, thread(threadIds.b, "Renamed")],
    });

    const reused = reuseUnchangedThreadShells(Option.some(previous), next);

    assert.strictEqual(reused.threads[0], previous.threads[0]);
    assert.strictEqual(reused.threads[1], next.threads[1]);
    assert.strictEqual(reused.snapshotSequence, 5);
  });

  it("returns the incoming snapshot when no row is unchanged", () => {
    const next = snapshot({ threads: [thread(threadIds.a, "New")] });

    assert.strictEqual(
      reuseUnchangedThreadShells(
        Option.some(snapshot({ threads: [thread(threadIds.a)] })),
        next
      ),
      next
    );
    assert.strictEqual(reuseUnchangedThreadShells(Option.none(), next), next);
  });
});

describe(applyShellStreamItem, () => {
  it("drops updates before the first snapshot, then follows the stream", () => {
    const early = applyShellStreamItem(
      Option.none(),
      ThreadUpdatedItem.make({ sequence: 1, thread: thread(threadIds.a) })
    );

    assert.isTrue(Option.isNone(early));

    const items = [
      ShellSnapshotItem.make({ snapshot: snapshot({ snapshotSequence: 2 }) }),
      ShellSynchronizedItem.make({}),
      ThreadUpdatedItem.make({
        sequence: 2,
        thread: thread(threadIds.a, "Already in the snapshot"),
      }),
      ThreadUpdatedItem.make({ sequence: 3, thread: thread(threadIds.b) }),
      ThreadUpdatedItem.make({ sequence: 4, thread: thread(threadIds.c) }),
      ThreadRemovedItem.make({ sequence: 5, threadId: threadIds.b }),
    ];

    const state = follow(early, items);

    assert.deepStrictEqual(shellCursor(state), Option.some(5));
    assert.deepStrictEqual(
      Option.map(state, (current) => current.threads.map((row) => row.id)),
      Option.some([threadIds.c])
    );
  });

  it("converges to the same state whether it replays or starts from a later snapshot", () => {
    const deltas = [
      ProjectUpdatedItem.make({
        sequence: 1,
        project: { ...project, title: "Renamed" },
      }),
      ThreadUpdatedItem.make({ sequence: 2, thread: thread(threadIds.a) }),
      ThreadUpdatedItem.make({
        sequence: 3,
        thread: thread(threadIds.a, "Second title"),
      }),
      ThreadUpdatedItem.make({ sequence: 4, thread: thread(threadIds.b) }),
    ];

    const replayed = follow(Option.none(), [
      ShellSnapshotItem.make({ snapshot: snapshot() }),
      ...deltas,
    ]);

    const fresh = applyShellStreamItem(
      Option.none(),
      ShellSnapshotItem.make({
        snapshot: snapshot({
          snapshotSequence: 4,
          projects: [{ ...project, title: "Renamed" }],
          threads: [thread(threadIds.a, "Second title"), thread(threadIds.b)],
        }),
      })
    );

    assert.deepStrictEqual(replayed, fresh);
  });
});
