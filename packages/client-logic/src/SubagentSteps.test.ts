// A subagent's steps: each state a child's row passes through, and the steps it reads as.

import { ApprovalId, EntryId, RunId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";

import { asking, EARLIER, NOW, rowId, shellRow } from "./ShellRowTestKit.ts";
import { childStepsOf, doneStepCount } from "./SubagentSteps.ts";

const child = (overrides: Partial<ThreadShell> = {}): ThreadShell =>
  shellRow(2, {
    lineage: Option.some({
      parentThreadId: rowId(1),
      relationshipToParent: "subagent",
      rootThreadId: rowId(1),
    }),
    ...overrides,
  });

const started: Partial<ThreadShell> = {
  latestRunStartedAt: Option.some(EARLIER),
};

const running: Partial<ThreadShell> = {
  ...started,
  activity: "running",
  activeRunId: Option.some(RunId.make(1)),
};

const answered: Partial<ThreadShell> = {
  ...started,
  latestRunCompletedAt: Option.some(NOW),
  latestVisibleMessage: Option.some({
    entryId: EntryId.make(7),
    role: "assistant",
    text: "There are 3 files.",
    at: NOW,
  }),
};

const NO_CONTEXT = { request: Option.none(), hasReport: false } as const;

/** Each step as `kind:state`, with its meta when it has one. */
const read = (row: ThreadShell, hasReport = false) =>
  childStepsOf(row, { ...NO_CONTEXT, hasReport }).map((step) =>
    Option.match(step.meta, {
      onNone: () => `${step.kind}:${step.state}`,
      onSome: (meta) => `${step.kind}:${step.state}(${meta})`,
    })
  );

describe("a subagent's steps", () => {
  it("starts with Go done and the start under way", () => {
    assert.deepStrictEqual(
      read(child({ activity: "preparing", activeRunId: Option.none() })),
      ["go:done", "started:now", "working:todo", "reported:todo"]
    );
  });

  it("works once its run started", () => {
    const steps = childStepsOf(child(running), NO_CONTEXT);

    assert.deepStrictEqual(read(child(running)), [
      "go:done",
      "started:done",
      "working:now",
      "reported:todo",
    ]);
    assert.strictEqual(doneStepCount(steps), 2);
  });

  it("names what holds it while it waits on someone", () => {
    assert.deepStrictEqual(read(child({ ...started, ...asking("apr_2") })), [
      "go:done",
      "started:done",
      "working:now(Input)",
      "reported:todo",
    ]);
    assert.deepStrictEqual(read(child({ ...running, waitingFor: "parent" })), [
      "go:done",
      "started:done",
      "working:now(Asked its parent)",
      "reported:todo",
    ]);
    assert.deepStrictEqual(
      read(
        child({
          ...running,
          pendingRuntimeRequest: Option.some({
            id: ApprovalId.make("apr_9"),
            kind: "tool-call",
            createdAt: NOW,
            origin: Option.none(),
          }),
        })
      ),
      ["go:done", "started:done", "working:now(Approval)", "reported:todo"]
    );
  });

  it("is done once it answered", () => {
    const steps = childStepsOf(child(answered), NO_CONTEXT);

    assert.deepStrictEqual(read(child(answered)), [
      "go:done",
      "started:done",
      "working:done",
      "reported:done",
    ]);
    assert.strictEqual(doneStepCount(steps), 4);
  });

  it("counts a report as the answer", () => {
    assert.deepStrictEqual(read(child(started), true), [
      "go:done",
      "started:done",
      "working:done",
      "reported:done",
    ]);
  });

  it("fails on the work when its run failed", () => {
    assert.deepStrictEqual(
      read(
        child({
          ...started,
          activity: "failed",
          lastError: Option.some("The model could not read the README."),
        })
      ),
      ["go:done", "started:done", "working:failed", "reported:todo"]
    );
  });

  it("stops on the work when its run ended without an answer", () => {
    assert.deepStrictEqual(
      read(child({ ...started, latestRunCompletedAt: Option.some(NOW) })),
      ["go:done", "started:done", "working:stopped", "reported:todo"]
    );
  });

  it("says where it started", () => {
    const [, inCheckout] = childStepsOf(child(running), NO_CONTEXT);

    const [, inWorktree] = childStepsOf(
      child({ ...running, worktreePath: Option.some("/tmp/wt") }),
      NO_CONTEXT
    );

    assert.strictEqual(inCheckout?.title, "Started, in the project's checkout");
    assert.strictEqual(inWorktree?.title, "Started, in a worktree");
  });
});
