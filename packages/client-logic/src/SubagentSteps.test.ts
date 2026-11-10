// A subagent's steps: each state a child's row passes through, and the steps it reads as.

import {
  ApprovalId,
  ConversationId,
  EntryId,
  RunId,
} from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import type { ChildCheck } from "@cairn/protocol/Subagents";
import type { Entry } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { Option } from "effect";
import type { Schema } from "effect";

import { asking, EARLIER, NOW, rowId, shellRow } from "./ShellRowTestKit.ts";
import {
  childStepsOf,
  doneStepCount,
  lastRunAnsweredIn,
} from "./SubagentSteps.ts";

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

/** A child at rest after it committed a tool-call step and was stopped before answering. */
const stoppedAfterAStep: Partial<ThreadShell> = {
  ...started,
  latestRunCompletedAt: Option.some(NOW),
  latestVisibleMessage: Option.some({
    entryId: EntryId.make(5),
    role: "assistant",
    text: "Let me list the files.",
    at: NOW,
  }),
};

const NO_CONTEXT = {
  request: Option.none(),
  hasReport: false,
  answered: Option.none(),
  check: Option.none(),
} as const;

/** Each step as `kind:state`, with its meta when it has one. */
const read = (
  row: ThreadShell,
  hasReport = false,
  endedOnAnswer: Option.Option<boolean> = Option.none()
) =>
  childStepsOf(row, { ...NO_CONTEXT, hasReport, answered: endedOnAnswer }).map(
    (step) =>
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

  it("is done once its last run ended on an answer", () => {
    const steps = childStepsOf(child(answered), {
      ...NO_CONTEXT,
      answered: Option.some(true),
    });

    assert.deepStrictEqual(read(child(answered), false, Option.some(true)), [
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
    const steps = childStepsOf(child(stoppedAfterAStep), {
      ...NO_CONTEXT,
      answered: Option.some(false),
    });

    assert.deepStrictEqual(
      read(child(stoppedAfterAStep), false, Option.some(false)),
      ["go:done", "started:done", "working:stopped", "reported:todo"]
    );
    assert.strictEqual(doneStepCount(steps), 2);
  });

  it("reads the row's last run while the transcript is not at hand", () => {
    assert.deepStrictEqual(read(child(answered)), [
      "go:done",
      "started:done",
      "working:done",
      "reported:done",
    ]);
    assert.deepStrictEqual(read(child(started)), [
      "go:done",
      "started:done",
      "working:stopped",
      "reported:todo",
    ]);
    assert.deepStrictEqual(
      read(
        child({
          latestRunStartedAt: Option.some(NOW),
          latestRunCompletedAt: Option.some(EARLIER),
        })
      ),
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

/** Each step as `kind:state(meta)` and the checked step's title, for `check` on `row`. */
const checked = (row: ThreadShell, check: ChildCheck) => {
  const steps = childStepsOf(row, {
    ...NO_CONTEXT,
    answered: Option.some(true),
    check: Option.some(check),
  });

  return {
    steps: steps.map((step) =>
      Option.match(step.meta, {
        onNone: () => `${step.kind}:${step.state}`,
        onSome: (meta) => `${step.kind}:${step.state}(${meta})`,
      })
    ),
    title: steps.at(-1)?.title,
    done: doneStepCount(steps),
  };
};

describe("a subagent's checked step (ADR 0055)", () => {
  const command = { argv: ["pnpm", "test"] as const, expectExit: 0 };

  const ran = {
    ...command,
    tail: null,
    sha: null,
    note: null,
    at: 1,
  };

  it("has no checked step when the brief names no command", () => {
    assert.isFalse(
      childStepsOf(child(answered), NO_CONTEXT).some(
        (step) => step.kind === "checked"
      )
    );
  });

  it("waits to be checked while the child works, and while the command runs", () => {
    assert.deepStrictEqual(
      checked(child(running), { verdict: "pending", ...command }).steps.at(-1),
      "checked:todo"
    );
    assert.deepStrictEqual(
      checked(child(running), { ...ran, verdict: "met", exit: 0 }).steps.at(-1),
      "checked:todo"
    );
    assert.deepStrictEqual(
      checked(child(answered), { verdict: "running", ...command }).steps.at(-1),
      "checked:now"
    );
  });

  it("is done when an outside judge found the command met", () => {
    assert.deepStrictEqual(
      checked(child(answered), { ...ran, verdict: "met", exit: 0 }),
      {
        steps: [
          "go:done",
          "started:done",
          "working:done",
          "reported:done",
          "checked:done",
        ],
        title: "Checked by an outside judge",
        done: 5,
      }
    );
  });

  it("fails with the exit code, or the timeout, when it was not met", () => {
    assert.deepStrictEqual(
      [
        checked(child(answered), { ...ran, verdict: "notMet", exit: 1 }),
        checked(child(answered), {
          ...ran,
          verdict: "notMet",
          exit: null,
          note: "timed out after 600 s",
        }),
      ].map(({ steps, title }) => [steps.at(-1), title]),
      [
        ["checked:failed(Exit 1)", "Not met by an outside judge"],
        [
          "checked:failed(timed out after 600 s)",
          "Not met by an outside judge",
        ],
      ]
    );
  });

  it("is stopped when Cairn did not run the command", () => {
    const seen = checked(child(answered), {
      ...command,
      verdict: "notRun",
      why: "the child runs in Supervised mode, where a command asks first",
      at: 1,
    });

    assert.deepStrictEqual(
      [seen.steps.at(-1), seen.title, seen.done],
      ["checked:stopped", "Not checked by an outside judge", 4]
    );
  });
});

const entry = (id: number, message: Schema.Json): Entry => ({
  id: EntryId.make(id),
  conversationId: ConversationId.make(3),
  kind: "pi.message",
  model: [message],
});

const user = (id: number) =>
  entry(id, { role: "user", content: "List the files.", timestamp: id });

const assistant = (id: number, stopReason: string) =>
  entry(id, { role: "assistant", content: [], stopReason, timestamp: id });

const toolResult = (id: number) =>
  entry(id, {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "bash",
    content: [],
    isError: false,
    timestamp: id,
  });

describe("whether a child's last run ended on an answer", () => {
  it("is an answer when its last message stopped with nothing left to call", () => {
    assert.deepStrictEqual(
      lastRunAnsweredIn([
        user(1),
        assistant(2, "toolUse"),
        toolResult(3),
        assistant(4, "stop"),
      ]),
      Option.some(true)
    );
  });

  it("is not one when the run stopped after a tool step or was cut off", () => {
    assert.deepStrictEqual(
      lastRunAnsweredIn([user(1), assistant(2, "toolUse"), toolResult(3)]),
      Option.some(false)
    );
    assert.deepStrictEqual(
      lastRunAnsweredIn([user(1), assistant(2, "aborted")]),
      Option.some(false)
    );
  });

  it("is not one when an input came after the last answer", () => {
    assert.deepStrictEqual(
      lastRunAnsweredIn([user(1), assistant(2, "stop"), user(3)]),
      Option.some(false)
    );
  });

  it("is unknown without a message", () => {
    assert.deepStrictEqual(
      lastRunAnsweredIn([
        {
          id: EntryId.make(1),
          conversationId: ConversationId.make(3),
          kind: "cairn.notice",
        },
      ]),
      Option.none()
    );
  });
});
