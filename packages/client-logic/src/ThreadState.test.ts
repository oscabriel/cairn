// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.logic.test.ts
// (`resolveSidebarThreadStatus`, the "unseen completion with background work" cases) and
// packages/client-runtime/src/state/threadShell.test.ts ("brings a parent back from Working while a
// nested subagent waits for approval") at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: approval
// over a question over busy work, a usage limit reading Limited until the next run, failed only
// while the latest run failed, Waiting static and Working timed, a finished thread whose background
// work still runs reading Waiting and receding, and a nested subagent's approval bringing its root
// back from Working. Changed: Cairn's shell rows and its one `threadState`, which also gives the
// category, words, tone and hold. Added: parked, a brief's Go, a child asking its parent, queued
// input, the holds and their order, and the label fallbacks.
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

import {
  ApprovalId,
  ProjectId,
  RunId,
  TaskId,
  ThreadId,
} from "@cairn/protocol/Ids";
import type { RuntimeRequestKind } from "@cairn/protocol/Policy";
import { BARE_ROW_FIELDS, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option } from "effect";

import { shouldRecedeSidebarThread } from "./Sidebar.ts";
import {
  pendingSubagentRequests,
  subagentRequestFor,
} from "./SubagentRollup.ts";
import {
  HOLD_LABELS,
  THREAD_LABELS,
  ThreadHold,
  threadHold,
  threadState,
  threadStatus,
} from "./ThreadState.ts";

const time = (iso: string) => DateTime.makeUnsafe(iso);

const NOW = time("2026-04-10T12:00:00.000Z");

const threadId = (suffix: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(suffix).padStart(4, "0")}`
  );

const base = ThreadShell.make({
  id: threadId(1),
  projectId: ProjectId.make("prj_1"),
  title: "A thread",
  provider: "opencode-go",
  modelId: "small",
  thinkingLevel: "off",
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
  createdAt: time("2026-04-10T08:00:00Z"),
  updatedAt: time("2026-04-10T08:00:00Z"),
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
  ...BARE_ROW_FIELDS,
});

const request = (kind: RuntimeRequestKind) =>
  Option.some({
    id: ApprovalId.make("apr_1"),
    kind,
    createdAt: time("2026-04-10T11:00:00Z"),
    origin: Option.none(),
  });

const none = Option.none();

const stateOf = (thread: ThreadShell) =>
  threadState(thread, { now: NOW, subagentRequest: none });

const wordOf = (thread: ThreadShell) =>
  Option.getOrUndefined(
    Option.map(stateOf(thread).label, (label) => label.word)
  );

describe(threadStatus, () => {
  it("prioritizes approval over a running thread, and a question below approval", () => {
    assert.strictEqual(
      threadStatus(
        {
          ...base,
          activity: "running",
          pendingRuntimeRequest: request("tool-call"),
        },
        none
      ),
      "approval"
    );
    assert.strictEqual(
      threadStatus(
        { ...base, pendingRuntimeRequest: request("executor-call") },
        none
      ),
      "approval"
    );
    assert.strictEqual(
      threadStatus(
        {
          ...base,
          activity: "running",
          pendingRuntimeRequest: request("user-input"),
        },
        none
      ),
      "input"
    );
    assert.strictEqual(
      threadStatus(
        { ...base, pendingRuntimeRequest: request("sign-in") },
        none
      ),
      "input"
    );
    assert.strictEqual(
      threadStatus(
        { ...base, pendingRuntimeRequest: request("user-input") },
        Option.some("approval")
      ),
      "approval"
    );
  });

  it("asks for Go on a brief and an approval on criteria", () => {
    assert.strictEqual(
      threadStatus({ ...base, pendingRuntimeRequest: request("brief") }, none),
      "go"
    );
    assert.strictEqual(
      threadStatus(
        { ...base, pendingRuntimeRequest: request("criteria") },
        none
      ),
      "approval"
    );
    assert.strictEqual(
      threadStatus(
        { ...base, pendingRuntimeRequest: request("brief") },
        Option.some("input")
      ),
      "go"
    );
  });

  it("reports working for preparing and running threads, and waiting for a waiting one", () => {
    assert.strictEqual(
      threadStatus({ ...base, activity: "running" }, none),
      "working"
    );
    assert.strictEqual(
      threadStatus({ ...base, activity: "preparing" }, none),
      "working"
    );
    assert.strictEqual(
      threadStatus({ ...base, activity: "waiting" }, none),
      "waiting"
    );
  });

  it("reports working for an idle thread whose input is queued", () => {
    assert.strictEqual(
      threadStatus({ ...base, queueLength: 1 }, none),
      "working"
    );
    assert.strictEqual(
      threadStatus({ ...base, activity: "failed", queueLength: 1 }, none),
      "failed"
    );
  });

  it("keeps usage-limit stops Limited and visible until the thread recovers", () => {
    const limited = {
      ...base,
      activity: "failed" as const,
      lastErrorClass: Option.some("usage_limit" as const),
    };

    assert.strictEqual(threadStatus(limited, none), "limited");
    assert.strictEqual(
      threadStatus({ ...limited, activity: "running" }, none),
      "working"
    );
    assert.strictEqual(
      threadStatus({ ...limited, activity: "idle" }, none),
      "ready"
    );
    assert.strictEqual(wordOf(limited), "Limited");
    assert.isFalse(
      shouldRecedeSidebarThread({
        status: "limited",
        isUnread: false,
        isWoke: false,
        isActive: false,
        isSelected: false,
      })
    );
  });

  it("reports failed only while the latest run failed", () => {
    assert.strictEqual(
      threadStatus(
        {
          ...base,
          activity: "failed",
          lastErrorClass: Option.some("provider_error"),
        },
        none
      ),
      "failed"
    );

    const recovered: ThreadShell = {
      ...base,
      lastError: Option.some("persisted"),
    };

    assert.strictEqual(threadStatus(recovered, none), "ready");
  });

  it("reports parked when a task is parked, so the row can offer a retry", () => {
    assert.strictEqual(
      threadStatus({ ...base, activity: "parked" }, none),
      "parked"
    );
    assert.strictEqual(
      threadStatus({ ...base, parkedTaskIds: [TaskId.make(7)] }, none),
      "parked"
    );
  });

  it("says a child asked its parent while the parent decides, before its run's work", () => {
    const asking = {
      ...base,
      activity: "running" as const,
      waitingFor: "parent" as const,
    };

    assert.strictEqual(threadStatus(asking, none), "asking-parent");
    assert.strictEqual(wordOf(asking), "Asked its parent");
    assert.strictEqual(
      threadStatus(
        { ...asking, pendingRuntimeRequest: request("tool-call") },
        none
      ),
      "approval"
    );
  });

  it("defaults to ready", () => {
    assert.strictEqual(threadStatus(base, none), "ready");
  });
});

describe(threadHold, () => {
  it("holds for a parked task first, then a spent window, then a Claude slot", () => {
    const all: ThreadShell = {
      ...base,
      activity: "failed",
      lastErrorClass: Option.some("usage_limit"),
      waitingFor: "claude_slot",
      parkedTaskIds: [TaskId.make(3), TaskId.make(4)],
    };

    assert.deepStrictEqual(
      threadHold(all),
      Option.some(ThreadHold.Parked({ taskId: TaskId.make(3) }))
    );
    assert.deepStrictEqual(
      threadHold({ ...all, parkedTaskIds: [] }),
      Option.some(ThreadHold.Limited({ resetsAt: Option.none() }))
    );
    assert.deepStrictEqual(
      threadHold({ ...all, parkedTaskIds: [], activity: "running" }),
      Option.some(ThreadHold.WaitingForSlot({ threadId: base.id }))
    );
    assert.isTrue(Option.isNone(threadHold(base)));
  });

  it("names each hold's badge", () => {
    assert.deepStrictEqual(
      [
        HOLD_LABELS.Parked.word,
        HOLD_LABELS.Limited.word,
        HOLD_LABELS.WaitingForSlot.word,
      ],
      ["Parked", "Limited", "Waiting"]
    );
  });

  it("keeps a row working under a Claude slot hold, in the held category", () => {
    const state = stateOf({
      ...base,
      activity: "running",
      waitingFor: "claude_slot",
    });

    assert.strictEqual(state.status, "working");
    assert.strictEqual(state.category, "held");
    assert.strictEqual(Option.getOrUndefined(state.label)?.word, "Working");
  });
});

describe(threadState, () => {
  it("keeps a waiting thread visible ahead of unread and woke presentation", () => {
    const state = stateOf({
      ...base,
      activity: "waiting",
      latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
      snoozedUntil: Option.some(time("2026-04-10T10:00:00Z")),
      snoozedAt: Option.some(time("2026-04-10T09:00:00Z")),
    });

    assert.isTrue(state.isUnread);
    assert.isTrue(state.isWoke);
    assert.deepStrictEqual(state.label, Option.some(THREAD_LABELS.waiting));
  });

  it("shows woke, then done, then nothing for a ready row", () => {
    const done = {
      ...base,
      latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
    };

    const woke = {
      ...done,
      snoozedUntil: Option.some(time("2026-04-10T10:00:00Z")),
      snoozedAt: Option.some(time("2026-04-10T09:00:00Z")),
    };

    assert.strictEqual(wordOf(woke), "Woke");
    assert.strictEqual(wordOf(done), "Done");
    assert.isTrue(Option.isNone(stateOf(base).label));
    assert.strictEqual(stateOf(base).category, "resting");
  });

  it("keeps Waiting static while Working shows elapsed duration", () => {
    assert.isFalse(stateOf({ ...base, activity: "waiting" }).showsDuration);
    assert.isTrue(stateOf({ ...base, activity: "running" }).showsDuration);
  });

  it("presents a completed thread whose subagents still work as Waiting, receded", () => {
    const thread: ThreadShell = {
      ...base,
      activeRunId: Option.none(),
      latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
      lastVisitedAt: Option.some(time("2026-04-10T10:59:00Z")),
      subagents: { working: 1, asking: 0, settled: 0, failed: 0 },
    };

    const state = stateOf(thread);

    assert.isTrue(state.isUnread);
    assert.strictEqual(state.status, "waiting");
    assert.strictEqual(state.category, "active");
    assert.deepStrictEqual(state.label, Option.some(THREAD_LABELS.waiting));
    assert.isTrue(
      shouldRecedeSidebarThread({
        status: state.status,
        isUnread: state.isUnread,
        isWoke: false,
        isActive: false,
        isSelected: false,
      })
    );

    const settled = stateOf({
      ...thread,
      subagents: { working: 0, asking: 0, settled: 2, failed: 1 },
    });

    assert.strictEqual(settled.status, "ready");
    assert.deepStrictEqual(settled.label, Option.some(THREAD_LABELS.done));
    assert.strictEqual(
      stateOf({
        ...thread,
        activity: "failed",
        lastErrorClass: Option.some("unknown"),
      }).status,
      "failed"
    );
  });

  it("brings a parent back from Working while a nested subagent waits for approval", () => {
    const runId = RunId.make(2);

    const root: ThreadShell = {
      ...base,
      latestRunCompletedAt: Option.some(time("2026-04-10T11:00:00Z")),
      subagents: { working: 1, asking: 0, settled: 0, failed: 0 },
    };

    const child: ThreadShell = {
      ...base,
      id: threadId(2),
      activity: "running",
      activeRunId: Option.some(runId),
      lineage: Option.some({
        parentThreadId: root.id,
        relationshipToParent: "subagent",
        rootThreadId: root.id,
      }),
    };

    const grandchild: ThreadShell = {
      ...child,
      id: threadId(3),
      lineage: Option.some({
        parentThreadId: child.id,
        relationshipToParent: "subagent",
        rootThreadId: root.id,
      }),
    };

    const rootState = (threads: ReadonlyArray<ThreadShell>) =>
      threadState(root, {
        now: NOW,
        subagentRequest: subagentRequestFor(
          pendingSubagentRequests(threads),
          root.id
        ),
      });

    assert.strictEqual(rootState([root, child, grandchild]).status, "waiting");

    const asking = rootState([
      root,
      child,
      { ...grandchild, pendingRuntimeRequest: request("executor-call") },
    ]);

    assert.strictEqual(asking.status, "approval");
    assert.strictEqual(asking.category, "waiting-on-you");
    assert.deepStrictEqual(asking.label, Option.some(THREAD_LABELS.approval));
    assert.strictEqual(rootState([root, child, grandchild]).status, "waiting");
  });

  it("gives every label words and a tone, and no label shows a raw status", () => {
    for (const [kind, label] of Object.entries(THREAD_LABELS)) {
      assert.strictEqual(label.kind, kind);
      assert.notStrictEqual(label.word, kind);
      assert.match(label.word, /^[A-Z][a-z]+(?: [a-z]+)*$/u);
    }
  });
});
