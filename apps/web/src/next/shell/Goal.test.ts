// The goal chip and panel (plan 6H): what they read from the thread's `cairn.goal` and approvals,
// what they draw (the chip's count equal to the document's met criteria, each criterion's state,
// judge and evidence, Met and Not met only on a user's criterion), what the controls send, and the
// shell update's side of it (one mark per criterion at a time, a failed mark said, one side panel at
// a time). The project thread's row in the sidebar counts its goal from the row's tally.

import { rowId, shellRow } from "@cairn/client-logic/ShellRowTestKit";
import { ConversationId } from "@cairn/protocol/Ids";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import { assert, describe, it } from "@effect/vitest";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { AppRoute } from "../../Route.ts";
import type { GoalInputs } from "./Goal.ts";
import { goalChipView, goalInputsOf, goalPanelView } from "./Goal.ts";
import { Message } from "./Message.ts";
import type { GoalPanelState } from "./Model.ts";
import { initial, initialGoalPanel, initialWork } from "./Model.ts";
import { onProjectThread, PROJECT_THREAD, SHELL } from "./ShellFixtures.ts";
import { sidebarList } from "./Sidebar.ts";
import { update } from "./Update.ts";
import { sidebarContentOf } from "./View.ts";

const GOAL_THREAD = 1;

type Json = Schema.Json;

const verdict = (ok: boolean, judge: Json, evidence: Json): Json => ({
  at: 20,
  ok,
  judge,
  evidence,
  runId: ok ? "judge-7" : "judge-8",
});

const COMMAND: Json = {
  kind: "command",
  argv: ["pnpm", "test"],
  expectExit: 0,
  timeoutSec: 600,
};

const MODEL: Json = {
  kind: "model",
  spec: "@judge",
  rubric: "The README says how to run it",
};

const NO_EVIDENCE = { exit: null, tail: null, sha: null, model: null };

const criterion = (
  id: string,
  text: string,
  judge: Json,
  state: "open" | "met" | "failed",
  found: Json = null
): Json => ({
  id,
  text,
  judge,
  state,
  verdict: found,
  tries: found === null ? 0 : 1,
  changedAt: 10,
});

/** A goal of four criteria: a command met, a model's not met, the user's and another open. */
const GOAL_DOC: Json = {
  objective: "Ship the parser",
  criteria: [
    criterion(
      "c1",
      "Tests pass",
      COMMAND,
      "met",
      verdict(true, COMMAND, {
        exit: 0,
        tail: "12 passed",
        sha: "0123456789abcdef",
        model: null,
        note: null,
      })
    ),
    criterion(
      "c2",
      "The README says how to run it",
      MODEL,
      "failed",
      verdict(false, MODEL, {
        ...NO_EVIDENCE,
        model: "opencode-go/gpt-6-luna",
        note: "NOT MET. It names no command.",
      })
    ),
    criterion("c3", "The user likes the output", { kind: "user" }, "open"),
    criterion("c4", "Lint is clean", COMMAND, "open"),
  ],
  envelope: null,
  closedAt: null,
  closedBy: null,
};

const shellOf = (threads: ReadonlyArray<ThreadShell>): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
});

const NO_THREAD_PAGE = {
  threadId: Option.none(),
  view: Option.none(),
} as const;

/** The goal's inputs for `open`, read the way the layout reads them. */
const inputsOf = (
  open: number,
  docs: Readonly<Record<string, Json>>,
  threads: ReadonlyArray<ThreadShell> = [shellRow(GOAL_THREAD)]
): Option.Option<GoalInputs> =>
  goalInputsOf({
    route: AppRoute.Thread({ threadId: rowId(open) }),
    shell: Option.some(shellOf(threads)),
    thread: {
      ...NO_THREAD_PAGE,
      threadId: Option.some(rowId(open)),
      view: Option.some({
        seq: 1,
        view: {
          conversation: { id: ConversationId.make(1) },
          entries: [],
          docs,
        },
        entriesOffset: 0,
        hasMoreHistory: false,
        older: [],
      }),
    },
  });

interface SceneModel {
  readonly goal: GoalPanelState;
  readonly sent: ReadonlyArray<string>;
}

const describeSent = (message: Message): string =>
  Predicate.isTagged(message, "ClickedMarkCriterion")
    ? `Mark:${message.criterionId}:${String(message.ok)}`
    : message._tag;

const appFor = (inputs: Option.Option<GoalInputs>) => ({
  update: (model: SceneModel, message: Message) => ({
    model: { ...model, sent: [...model.sent, describeSent(message)] },
  }),
  view: (model: SceneModel, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        goalChipView(model.goal, { inputs }, h),
        goalPanelView(model.goal, { inputs }, h),
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
});

const givenGoal = (goal: Partial<GoalPanelState> = {}) =>
  Scene.given<SceneModel>({
    goal: { ...initialGoalPanel, isOpen: true, ...goal },
    sent: [],
  });

const expectSent = (words: string) =>
  Scene.expect(Scene.testId("sent")).toHaveText(words);

const row = (id: string) =>
  Scene.selector(`[data-testid="goal-criterion"][data-criterion-id="${id}"]`);

const goalInputs = inputsOf(GOAL_THREAD, { "cairn.goal": GOAL_DOC });

describe("what the goal chip reads", () => {
  it("shows nothing off a thread, or for a thread with no criteria", () => {
    assert.isTrue(
      Option.isNone(
        goalInputsOf({
          route: AppRoute.Hero(),
          shell: Option.some(shellOf([shellRow(GOAL_THREAD)])),
          thread: { ...NO_THREAD_PAGE },
        })
      )
    );
    assert.isTrue(Option.isNone(inputsOf(GOAL_THREAD, {})));
    assert.isTrue(
      Option.isNone(
        inputsOf(GOAL_THREAD, {
          "cairn.goal": {
            objective: "Nothing yet",
            criteria: [],
            envelope: null,
            closedAt: null,
            closedBy: null,
          },
        })
      )
    );
  });

  it("counts the document's criteria, not the row's", () => {
    // The row still says nothing is met (its tally arrives on its own); the chip reads the record.
    const stale = shellRow(GOAL_THREAD, {
      goal: Option.some({ total: 4, met: 0, failed: 0 }),
    });

    const inputs = Option.getOrThrow(
      inputsOf(GOAL_THREAD, { "cairn.goal": GOAL_DOC }, [stale])
    );

    assert.deepStrictEqual(inputs.tally, { total: 4, met: 1, failed: 1 });
    assert.strictEqual(inputs.progress.line, "1 of 4 criteria met, 1 not met");
  });

  it("keeps one inputs object while the shell and documents are the same", () => {
    const shell = Option.some(shellOf([shellRow(GOAL_THREAD)]));

    const view = Option.some({
      seq: 1,
      view: {
        conversation: { id: ConversationId.make(1) },
        entries: [],
        docs: { "cairn.goal": GOAL_DOC },
      },
      entriesOffset: 0,
      hasMoreHistory: false,
      older: [],
    });

    const read = () =>
      goalInputsOf({
        route: AppRoute.Thread({ threadId: rowId(GOAL_THREAD) }),
        shell,
        thread: { threadId: Option.some(rowId(GOAL_THREAD)), view },
      });

    assert.strictEqual(read(), read());
  });
});

describe("the goal chip and panel", () => {
  it("draws the chip's count from the records and each criterion as its verdict left it", () => {
    Scene.scene(
      appFor(goalInputs),
      givenGoal(),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr("data-met", "1"),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr("data-total", "4"),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr(
        "data-state",
        "failed"
      ),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr(
        "aria-label",
        "Goal: 1 of 4 met, 1 not met"
      ),
      Scene.expect(Scene.testId("goal-objective")).toHaveText(
        "Ship the parser"
      ),
      Scene.expectAll(
        Scene.all.selector('[data-testid="goal-criterion"]')
      ).toHaveCount(4),
      Scene.expect(row("c1")).toHaveAttr("data-state", "met"),
      Scene.expect(row("c1")).toContainText("Met"),
      Scene.expect(row("c1")).toContainText("Judged by Command: pnpm test"),
      Scene.expect(row("c1")).toContainText("Exit 0"),
      Scene.expect(row("c1")).toContainText("12 passed"),
      Scene.expect(row("c2")).toHaveAttr("data-state", "failed"),
      Scene.expect(row("c2")).toContainText("Not met"),
      Scene.expect(row("c2")).toContainText("Judged by Model: @judge"),
      Scene.expect(row("c2")).toContainText("Judged by opencode-go/gpt-6-luna"),
      Scene.expect(row("c3")).toHaveAttr("data-state", "open"),
      Scene.expect(row("c3")).toContainText("Judged by You"),
      // Only the user's criterion takes a mark; a command's and a model's are their runs'.
      Scene.expectAll(
        Scene.all.selector('[data-testid="goal-mark-met"]')
      ).toHaveCount(1),
      Scene.expect(
        Scene.selector(`[data-criterion-id="c3"] [data-testid="goal-mark-met"]`)
      ).toHaveAttr("aria-pressed", "false"),
      Scene.click(
        Scene.selector(`[data-criterion-id="c3"] [data-testid="goal-mark-met"]`)
      ),
      Scene.click(
        Scene.selector(
          `[data-criterion-id="c3"] [data-testid="goal-mark-not-met"]`
        )
      ),
      expectSent("Mark:c3:true,Mark:c3:false"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("presses the mark the user's verdict holds, and takes no tap while a mark is out", () => {
    const marked = inputsOf(GOAL_THREAD, {
      "cairn.goal": {
        objective: "Ship the parser",
        envelope: null,
        closedAt: null,
        closedBy: null,
        criteria: [
          criterion(
            "c3",
            "The user likes the output",
            { kind: "user" },
            "met",
            verdict(true, { kind: "user" }, { ...NO_EVIDENCE, note: null })
          ),
        ],
      },
    });

    Scene.scene(
      appFor(marked),
      givenGoal(),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr("data-state", "met"),
      Scene.expect(Scene.testId("goal-mark-met")).toHaveAttr(
        "aria-pressed",
        "true"
      ),
      Scene.expect(Scene.testId("goal-mark-not-met")).toHaveAttr(
        "aria-pressed",
        "false"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    Scene.scene(
      appFor(marked),
      givenGoal({ marking: ["c3"] }),
      Scene.expect(Scene.testId("goal-mark-met")).toHaveAttr(
        "aria-busy",
        "true"
      ),
      Scene.expect(Scene.testId("goal-mark-met")).toBeDisabled(),
      Scene.expect(Scene.testId("goal-mark-not-met")).toBeDisabled(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws only the chip while closed, and closes from its button and the scrim", () => {
    Scene.scene(
      appFor(goalInputs),
      givenGoal({ isOpen: false }),
      Scene.expect(Scene.testId("goal-panel")).toBeAbsent(),
      Scene.expect(Scene.testId("goal-chip")).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      Scene.click(Scene.testId("goal-chip")),
      expectSent("ClickedGoal"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    Scene.scene(
      appFor(goalInputs),
      givenGoal(),
      Scene.click(Scene.testId("goal-close")),
      Scene.click(Scene.testId("goal-scrim")),
      expectSent("ClickedCloseGoal,ClickedCloseGoal"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says why a mark failed, and dismisses it", () => {
    Scene.scene(
      appFor(goalInputs),
      givenGoal({ failure: Option.some("The mark did not reach Cairn.") }),
      Scene.expect(Scene.testId("goal-failure")).toContainText(
        "The mark did not reach Cairn."
      ),
      Scene.click(Scene.role("button", { name: "Dismiss" })),
      expectSent("ClickedDismissGoalFailure"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the shell's update for the goal panel", () => {
  const mark = Message.ClickedMarkCriterion({
    threadId: rowId(GOAL_THREAD),
    criterionId: "c3",
    ok: true,
  });

  it("sends one mark per criterion at a time, and lets it go once answered", () => {
    const first = update(initial, mark);

    assert.deepStrictEqual(first.model.goal.marking, ["c3"]);
    assert.strictEqual(first.commands?.length, 1);
    assert.strictEqual(update(first.model, mark).commands?.length ?? 0, 0);

    const answered = update(
      first.model,
      Message.MarkedCriterion({ criterionId: "c3" })
    ).model;

    assert.deepStrictEqual(answered.goal.marking, []);
    assert.strictEqual(update(answered, mark).commands?.length, 1);
  });

  it("says why a mark failed and offers it again", () => {
    const failed = update(
      update(initial, mark).model,
      Message.FailedMarkCriterion({
        criterionId: "c3",
        message: "Cairn is reconnecting. Mark it again once it is back.",
      })
    ).model;

    assert.deepStrictEqual(failed.goal.marking, []);
    assert.deepStrictEqual(
      failed.goal.failure,
      Option.some("Cairn is reconnecting. Mark it again once it is back.")
    );
    assert.isTrue(
      Option.isNone(
        update(failed, Message.ClickedDismissGoalFailure()).model.goal.failure
      )
    );
  });

  it("shows one side panel at a time", () => {
    const working = { ...initial, work: { ...initialWork, isOpen: true } };
    const goal = update(working, Message.ClickedGoal()).model;

    assert.isTrue(goal.goal.isOpen);
    assert.isFalse(goal.work.isOpen);

    const work = update(goal, Message.ClickedWork()).model;

    assert.isTrue(work.work.isOpen);
    assert.isFalse(work.goal.isOpen);
    assert.isFalse(update(goal, Message.ClickedCloseGoal()).model.goal.isOpen);
  });
});

/** The sidebar list on the project thread, its row's goal tally `goal`. */
const listWith = (goal: ThreadShell["goal"]) => {
  const shell = {
    ...SHELL,
    threads: SHELL.threads.map((thread) =>
      thread.id === PROJECT_THREAD ? { ...thread, goal } : thread
    ),
  };

  const content = sidebarContentOf({
    ...onProjectThread,
    context: { ...onProjectThread.context, shell: Option.some(shell) },
  });

  return {
    update: (model: null) => ({ model }),
    view: (_model: null, h: HtmlBuilder<Message>): Html =>
      sidebarList(h, content),
  };
};

describe("the project thread's row", () => {
  it("counts its goal from the row's tally, and says nothing without one", () => {
    Scene.scene(
      listWith(Option.some({ total: 4, met: 2, failed: 1 })),
      Scene.given(null),
      Scene.expect(Scene.testId("shell-goal-tally")).toHaveText("2/4 met"),
      Scene.expect(Scene.testId("shell-goal-tally")).toHaveAttr(
        "title",
        "Goal: 2 of 4 met, 1 not met"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    Scene.scene(
      listWith(Option.none()),
      Scene.given(null),
      Scene.expect(Scene.testId("shell-project-thread")).toExist(),
      Scene.expect(Scene.testId("shell-goal-tally")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});
