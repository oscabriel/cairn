// The work panel's lineage. The window and ordering cases are ported from github.com/pingdotgg/t3code,
// apps/web/src/components/chat/ThreadRelationshipsControl.test.tsx ("thread lineage window") and
// packages/client-runtime/src/state/threadRelationships.test.ts ("keeps missing parents and cycles
// navigable", "orders sibling forks newest created first", "does not reorder when related-thread
// activity arrives", "keeps the live shell") at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92, as
// subagent edges; the status cases are Cairn's (the one thread-state function, the registry's
// settlement at rest).
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

import { ApprovalId, RunId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { asking, EARLIER, NOW, rowId, shellRow } from "./ShellRowTestKit.ts";
import {
  ancestorsOf,
  childStatusOf,
  hasLineage,
  LINEAGE_FIRST_PAGE,
  lineageOf,
  lineageWindow,
  settledOutcomesOf,
  showMoreCount,
} from "./ThreadLineage.ts";

const childOf = (
  n: number,
  parent: number,
  overrides: Partial<ThreadShell> = {}
): ThreadShell =>
  shellRow(n, {
    title: `Child ${String(n)}`,
    lineage: Option.some({
      parentThreadId: rowId(parent),
      relationshipToParent: "subagent",
      rootThreadId: rowId(1),
    }),
    ...overrides,
  });

const created = (minute: number): Partial<ThreadShell> => ({
  createdAt: DateTime.makeUnsafe(
    `2026-10-29T10:${String(minute).padStart(2, "0")}:00.000Z`
  ),
});

const working: Partial<ThreadShell> = {
  activity: "running",
  activeRunId: Option.some(RunId.make(1)),
  latestRunStartedAt: Option.some(EARLIER),
};

const ids = (rows: ReadonlyArray<{ readonly thread: ThreadShell }>) =>
  rows.map(({ thread }) => thread.id);

describe("the lineage window", () => {
  const rows = Array.from({ length: 20 }, (_, index) => `row-${index}`);

  it("shows six rows before the first expansion", () => {
    const { visibleRows, hiddenCount } = lineageWindow(
      rows,
      LINEAGE_FIRST_PAGE
    );

    assert.deepStrictEqual(visibleRows, rows.slice(0, 6));
    assert.strictEqual(hiddenCount, 14);
    assert.strictEqual(showMoreCount(hiddenCount), 12);
  });

  it("hides nothing when everything fits", () => {
    assert.strictEqual(lineageWindow(rows, rows.length).hiddenCount, 0);
    assert.strictEqual(lineageWindow(rows.slice(0, 6), 6).hiddenCount, 0);
    assert.strictEqual(showMoreCount(2), 2);
  });
});

describe("the lineage of a thread", () => {
  it("orders children newest created first", () => {
    const threads = [
      shellRow(1, created(0)),
      childOf(2, 1, created(1)),
      childOf(3, 1, created(3)),
      childOf(4, 1, created(2)),
    ];

    const lineage = lineageOf(rowId(1), threads, new Map());

    assert.deepStrictEqual(ids(lineage.previous), [
      rowId(3),
      rowId(4),
      rowId(2),
    ]);
  });

  it("does not reorder children when their activity arrives", () => {
    const before = [
      shellRow(1),
      childOf(2, 1, { ...created(1), ...working }),
      childOf(3, 1, { ...created(2), ...working }),
    ];

    const after = [
      shellRow(1),
      childOf(2, 1, { ...created(1), ...working, updatedAt: NOW }),
      childOf(3, 1, { ...created(2), ...working }),
    ];

    assert.deepStrictEqual(
      ids(lineageOf(rowId(1), before, new Map()).active),
      ids(lineageOf(rowId(1), after, new Map()).active)
    );
  });

  it("puts live children before resting ones, each in its own group", () => {
    const threads = [
      shellRow(1),
      childOf(2, 1, { ...created(1), ...working }),
      childOf(3, 1, {
        ...created(2),
        latestRunStartedAt: Option.some(EARLIER),
        latestRunCompletedAt: Option.some(NOW),
      }),
      childOf(4, 1, { ...created(3), ...asking("apr_4") }),
      childOf(5, 1, {
        ...created(4),
        activity: "failed",
        lastError: Option.some("boom"),
      }),
    ];

    const lineage = lineageOf(rowId(1), threads, new Map());

    assert.deepStrictEqual(ids(lineage.active), [rowId(4), rowId(2)]);
    assert.deepStrictEqual(
      lineage.active.map(({ status }) => status),
      ["input", "working"]
    );
    assert.deepStrictEqual(ids(lineage.previous), [rowId(5), rowId(3)]);
    assert.deepStrictEqual(
      lineage.previous.map(({ label }) => label.word),
      ["Failed", "Done"]
    );
  });

  it("reads a resting child's outcome from the parent's registry", () => {
    const threads = [
      shellRow(1),
      childOf(2, 1, {
        latestRunStartedAt: Option.some(EARLIER),
        latestRunCompletedAt: Option.some(NOW),
      }),
    ];

    const lineage = lineageOf(
      rowId(1),
      threads,
      new Map([[rowId(2), "stopped" as const]])
    );

    assert.deepStrictEqual(
      lineage.previous.map(({ status, label }) => [status, label.word]),
      [["stopped", "Stopped"]]
    );
  });

  it("lets a working row win over an older settlement", () => {
    const status = childStatusOf(
      childOf(2, 1, working),
      Option.none(),
      Option.some("completed")
    );

    assert.strictEqual(status, "working");
  });

  it("calls a child that never ran idle, and one stopped mid-run stopped", () => {
    assert.strictEqual(
      childStatusOf(childOf(2, 1), Option.none(), Option.none()),
      "idle"
    );
    assert.strictEqual(
      childStatusOf(
        childOf(2, 1, { latestRunStartedAt: Option.some(EARLIER) }),
        Option.none(),
        Option.none()
      ),
      "stopped"
    );
  });

  it("lights a parent row whose grandchild asks", () => {
    const threads = [
      shellRow(1),
      childOf(2, 1, {
        latestRunStartedAt: Option.some(EARLIER),
        latestRunCompletedAt: Option.some(NOW),
      }),
      childOf(3, 2, {
        ...asking("apr_3"),
        pendingRuntimeRequest: Option.some({
          id: ApprovalId.make("apr_3"),
          kind: "tool-call",
          createdAt: NOW,
          origin: Option.none(),
        }),
      }),
    ];

    const lineage = lineageOf(rowId(1), threads, new Map());

    assert.deepStrictEqual(
      lineage.active.map(({ status }) => status),
      ["approval"]
    );
  });

  it("walks the parent chain to the root, nearest first", () => {
    const threads = [shellRow(1), childOf(2, 1), childOf(3, 2)];

    assert.deepStrictEqual(
      ancestorsOf(rowId(3), threads).map(({ threadId }) => threadId),
      [rowId(2), rowId(1)]
    );
    assert.isTrue(hasLineage(lineageOf(rowId(3), threads, new Map())));
    assert.isFalse(hasLineage(lineageOf(rowId(1), [shellRow(1)], new Map())));
  });

  it("keeps a missing parent as a node and walks a loop once", () => {
    const missing = childOf(2, 9);
    const loopA = childOf(3, 4);
    const loopB = childOf(4, 3);

    const toMissing = ancestorsOf(rowId(2), [missing]);

    assert.deepStrictEqual(
      toMissing.map(({ threadId, thread }) => [
        threadId,
        Option.isSome(thread),
      ]),
      [[rowId(9), false]]
    );
    assert.deepStrictEqual(
      ancestorsOf(rowId(3), [loopA, loopB]).map(({ threadId }) => threadId),
      [rowId(4)]
    );
  });

  it("keeps the first row of an id", () => {
    const live = childOf(2, 1, { ...working, title: "Live child" });
    const stale = childOf(2, 1, { title: "Stale child" });

    const lineage = lineageOf(rowId(1), [shellRow(1), live, stale], new Map());

    assert.deepStrictEqual(
      lineage.active.map(({ thread }) => thread.title),
      ["Live child"]
    );
    assert.strictEqual(lineage.previous.length, 0);
  });
});

/** A registry item as the brain writes it, with its settlements. */
const item = (
  threadId: string,
  settlements: ReadonlyArray<{ outcome: string; reportedAt: number }>
) => ({
  threadId,
  briefApprovalId: `brief-${threadId}`,
  status: "settled",
  dispatch: { dispatchedAt: 1 },
  settlements,
});

describe("the registry's settlements", () => {
  it("takes each child's latest settlement and skips a child with none", () => {
    const outcomes = settledOutcomesOf({
      items: {
        a: item(rowId(2), [
          { outcome: "completed", reportedAt: 2 },
          { outcome: "stopped", reportedAt: 3 },
        ]),
        b: item(rowId(3), []),
      },
    });

    assert.deepStrictEqual([...outcomes], [[rowId(2), "stopped"]]);
    assert.strictEqual(settledOutcomesOf(undefined).size, 0);
  });
});
