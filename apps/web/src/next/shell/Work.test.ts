// The work panel (plan 6E): what it reads from the shell and the thread's documents, what it draws
// for a parent and for a subagent (lineage with Stop, "Previous" folded and paged, steps, workflows),
// what its controls send, and the shell update's side of it (Stop asked once, Stopping cleared once
// the child rests or the stop answers, a failed Stop said, a new thread starting at the first page).

import {
  asking,
  EARLIER,
  NOW,
  rowId,
  shellRow,
} from "@cairn/client-logic/ShellRowTestKit";
import { ConversationId, EntryId, RunId, ThreadId } from "@cairn/protocol/Ids";
import type { ShellSnapshot, ThreadShell } from "@cairn/protocol/Shell";
import type { Entry } from "@cairn/protocol/Thread";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Option, Predicate } from "effect";
import type { Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";

import { AppRoute } from "../../Route.ts";
import { Message } from "./Message.ts";
import type { WorkState } from "./Model.ts";
import { initial, initialWork } from "./Model.ts";
import { inform, update } from "./Update.ts";
import type { WorkInputs } from "./Work.ts";
import {
  workInputsOf,
  workPanelView,
  workToggleText,
  workToggleView,
} from "./Work.ts";

const PARENT = 1;

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

const answered: Partial<ThreadShell> = {
  latestRunStartedAt: Option.some(EARLIER),
  latestRunCompletedAt: Option.some(NOW),
  latestVisibleMessage: Option.some({
    entryId: EntryId.make(4),
    role: "assistant",
    text: "There are 3 files.",
    at: NOW,
  }),
};

const childOf = (
  n: number,
  title: string,
  overrides: Partial<ThreadShell> = {},
  parent = PARENT
): ThreadShell =>
  shellRow(n, {
    title,
    lineage: Option.some({
      parentThreadId: rowId(parent),
      relationshipToParent: "subagent",
      rootThreadId: rowId(PARENT),
    }),
    ...created(n),
    ...overrides,
  });

const shellOf = (threads: ReadonlyArray<ThreadShell>): ShellSnapshot => ({
  snapshotSequence: 1,
  projects: [],
  threads,
});

const NO_THREAD_PAGE = {
  threadId: Option.none(),
  view: Option.none(),
} as const;

/** The work panel's inputs for `open`, read the way the layout reads them. */
const inputsOf = (
  open: number,
  threads: ReadonlyArray<ThreadShell>,
  docs: Readonly<Record<string, Schema.Json>> = {},
  entries: ReadonlyArray<Entry> = []
): Option.Option<WorkInputs> =>
  workInputsOf({
    route: AppRoute.Thread({ threadId: rowId(open) }),
    shell: Option.some(shellOf(threads)),
    thread: {
      ...NO_THREAD_PAGE,
      threadId: Option.some(rowId(open)),
      view: Option.some({
        seq: 1,
        view: {
          conversation: { id: ConversationId.make(1) },
          entries,
          docs,
        },
        entriesOffset: 0,
        hasMoreHistory: false,
        older: [],
      }),
    },
  });

/** A committed transcript entry carrying one model message. */
const modelEntry = (id: number, model: Schema.Json): Entry => ({
  id: EntryId.make(id),
  conversationId: ConversationId.make(1),
  kind: "pi.message",
  model: [model],
});

const FAMILY = [
  shellRow(PARENT, { title: "Plan the port" }),
  childOf(2, "Count the files", working),
  childOf(3, "Read the README", { ...asking("apr_3"), ...working }),
  childOf(4, "List the docs", answered),
];

interface SceneModel {
  readonly work: WorkState;
  readonly sent: ReadonlyArray<string>;
}

/** What a sent Message reads as in the list: its tag, and the child or group it names. */
const describeSent = (message: Message): string => {
  if (Predicate.isTagged(message, "ClickedStopChild")) {
    return `Stop:${message.threadId.slice(-4)}`;
  }

  if (Predicate.isTagged(message, "ClickedStopWorkflow")) {
    return `StopWorkflow:${message.workflowId}${Option.match(message.nodeId, {
      onNone: () => "",
      onSome: (node) => `/${node}`,
    })}`;
  }

  if (Predicate.isTagged(message, "ClickedMoreChildren")) {
    return `More:${message.group}`;
  }

  return message._tag;
};

const appFor = (inputs: Option.Option<WorkInputs>) => ({
  update: (model: SceneModel, message: Message) => ({
    model: { ...model, sent: [...model.sent, describeSent(message)] },
  }),
  view: (model: SceneModel, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        workToggleView(model.work, { inputs }, h),
        workPanelView(model.work, { inputs }, h),
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
});

const givenWork = (work: Partial<WorkState> = {}) =>
  Scene.given<SceneModel>({
    work: { ...initialWork, isOpen: true, ...work },
    sent: [],
  });

const expectSent = (words: string) =>
  Scene.expect(Scene.testId("sent")).toHaveText(words);

const child = (n: number) =>
  Scene.selector(`[data-testid="work-child"][data-thread-id="${rowId(n)}"]`);

describe("what the work panel reads", () => {
  it("shows nothing off a thread, or for a thread with no tree", () => {
    assert.isTrue(
      Option.isNone(
        workInputsOf({
          route: AppRoute.Hero(),
          shell: Option.some(shellOf(FAMILY)),
          thread: { ...NO_THREAD_PAGE },
        })
      )
    );
    assert.isTrue(Option.isNone(inputsOf(9, [shellRow(9)])));
  });

  it("keeps one inputs object while the shell and documents are the same", () => {
    const shell = Option.some(shellOf(FAMILY));

    const read = () =>
      workInputsOf({
        route: AppRoute.Thread({ threadId: rowId(PARENT) }),
        shell,
        thread: { ...NO_THREAD_PAGE },
      });

    assert.strictEqual(read(), read());
  });

  it("counts a parent's children and a subagent's steps for the header", () => {
    assert.strictEqual(
      Option.map(inputsOf(PARENT, FAMILY), workToggleText).pipe(
        Option.getOrThrow
      ),
      "3 subagents"
    );
    assert.strictEqual(
      Option.map(inputsOf(4, FAMILY), workToggleText).pipe(Option.getOrThrow),
      "4/4 steps"
    );
    assert.strictEqual(
      Option.map(inputsOf(2, FAMILY), workToggleText).pipe(Option.getOrThrow),
      "2/4 steps"
    );
  });

  it("reads a resting child's ending from the open thread's registry", () => {
    const stopped = Option.getOrThrow(
      inputsOf(PARENT, FAMILY, {
        "cairn.subagents": {
          items: {
            k: {
              threadId: rowId(4),
              briefApprovalId: "brief-4",
              status: "settled",
              dispatch: { dispatchedAt: 1 },
              settlements: [{ outcome: "stopped", reportedAt: 2 }],
            },
          },
        },
      })
    );

    assert.deepStrictEqual(
      stopped.lineage.previous.map(({ status }) => status),
      ["stopped"]
    );
  });
});

describe("the work panel on a parent", () => {
  const inputs = inputsOf(PARENT, FAMILY);

  it("lists live children first with Stop, and folds the resting ones", () => {
    Scene.scene(
      appFor(inputs),
      givenWork(),
      Scene.expect(Scene.testId("work-toggle")).toContainText("3 subagents"),
      Scene.expect(Scene.testId("work-toggle")).toHaveAttr(
        "aria-expanded",
        "true"
      ),
      Scene.expect(child(3)).toHaveAttr("data-state", "input"),
      Scene.expect(child(3)).toContainText("Input"),
      Scene.expect(child(2)).toHaveAttr("data-state", "working"),
      Scene.expect(child(2)).toContainText("Working"),
      Scene.expect(
        Scene.selector(`[data-testid="work-children"] a[href="/t/${rowId(2)}"]`)
      ).toExist(),
      Scene.expect(child(4)).toBeAbsent(),
      Scene.expect(Scene.testId("work-previous-toggle")).toContainText(
        "Previous (1)"
      ),
      Scene.click(Scene.role("button", { name: "Stop Count the files" })),
      Scene.click(Scene.testId("work-previous-toggle")),
      expectSent(`Stop:${rowId(2).slice(-4)},ClickedPreviousChildren`),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows the previous group open, with no Stop on a resting child", () => {
    Scene.scene(
      appFor(inputs),
      givenWork({ isPreviousOpen: true }),
      Scene.expect(child(4)).toHaveAttr("data-state", "done"),
      Scene.expect(child(4)).toContainText("Done"),
      Scene.expect(
        Scene.role("button", { name: "Stop List the docs" })
      ).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says Stopping in place of Stop once asked", () => {
    Scene.scene(
      appFor(inputs),
      givenWork({ stopping: [rowId(2)] }),
      Scene.expect(child(2)).toContainText("Stopping"),
      Scene.expect(child(2)).toHaveAttr("data-stopping", "true"),
      Scene.expect(
        Scene.role("button", { name: "Stop Count the files" })
      ).toBeAbsent(),
      Scene.expect(
        Scene.role("button", { name: "Stop Read the README" })
      ).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("offers no Stop on a child a stop cannot end", () => {
    const held = [
      shellRow(PARENT),
      childOf(2, "Wait on its own child", {
        ...working,
        activity: "waiting",
        activeRunId: Option.none(),
      }),
      childOf(3, "Hit the usage limit", {
        latestRunStartedAt: Option.some(EARLIER),
        activity: "failed",
        lastErrorClass: Option.some("usage_limit"),
        lastError: Option.some("Usage limit reached."),
      }),
      childOf(4, "Count the files", working),
    ];

    Scene.scene(
      appFor(inputsOf(PARENT, held)),
      givenWork(),
      Scene.expect(child(2)).toHaveAttr("data-state", "waiting"),
      Scene.expect(child(3)).toHaveAttr("data-state", "limited"),
      Scene.expect(
        Scene.role("button", { name: "Stop Wait on its own child" })
      ).toBeAbsent(),
      Scene.expect(
        Scene.role("button", { name: "Stop Hit the usage limit" })
      ).toBeAbsent(),
      Scene.expect(
        Scene.role("button", { name: "Stop Count the files" })
      ).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("shows six live children, then twelve more per Show more", () => {
    const many = [
      shellRow(PARENT),
      ...Array.from({ length: 8 }, (_, index) =>
        childOf(10 + index, `Child ${String(index)}`, working)
      ),
    ];

    Scene.scene(
      appFor(inputsOf(PARENT, many)),
      givenWork(),
      Scene.expectAll(
        Scene.all.selector('[data-testid="work-child"]')
      ).toHaveCount(6),
      Scene.expect(Scene.testId("work-children-more")).toHaveText(
        "Show 2 more"
      ),
      Scene.click(Scene.testId("work-children-more")),
      expectSent("More:active"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );

    Scene.scene(
      appFor(inputsOf(PARENT, many)),
      givenWork({ shownActive: 18 }),
      Scene.expectAll(
        Scene.all.selector('[data-testid="work-child"]')
      ).toHaveCount(8),
      Scene.expect(Scene.testId("work-children-more")).toBeAbsent(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("draws nothing while closed but the header's button", () => {
    Scene.scene(
      appFor(inputs),
      givenWork({ isOpen: false }),
      Scene.expect(Scene.testId("work-panel")).toBeAbsent(),
      Scene.expect(Scene.testId("work-toggle")).toHaveAttr(
        "aria-expanded",
        "false"
      ),
      Scene.click(Scene.testId("work-toggle")),
      expectSent("ClickedWork"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("closes from its button and from the scrim", () => {
    Scene.scene(
      appFor(inputs),
      givenWork(),
      Scene.click(Scene.testId("work-close")),
      Scene.click(Scene.testId("work-scrim")),
      expectSent("ClickedCloseWork,ClickedCloseWork"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

describe("the work panel on a subagent", () => {
  const grandchild = childOf(5, "Check one file", working, 2);

  it("leads with its steps, then the way up and its own children", () => {
    Scene.scene(
      appFor(inputsOf(2, [...FAMILY, grandchild])),
      givenWork(),
      Scene.expect(Scene.testId("work-toggle")).toContainText("2/4 steps"),
      Scene.expect(Scene.selector('[data-slot="work-steps-count"]')).toHaveText(
        "2 of 4"
      ),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="go"]')
      ).toHaveAttr("data-step-state", "done"),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="working"]')
      ).toHaveAttr("data-step-state", "now"),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="reported"]')
      ).toHaveAttr("data-step-state", "todo"),
      Scene.expect(Scene.testId("work-ancestor")).toContainText(
        "Plan the port"
      ),
      Scene.expect(
        Scene.selector(
          `[data-testid="work-ancestor"] a[href="/t/${rowId(PARENT)}"]`
        )
      ).toExist(),
      Scene.expect(child(5)).toHaveAttr("data-state", "working"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("reads a child stopped after a tool step as stopped, not done", () => {
    const stopped = childOf(6, "Read the README", {
      latestRunStartedAt: Option.some(EARLIER),
      latestRunCompletedAt: Option.some(NOW),
      latestVisibleMessage: Option.some({
        entryId: EntryId.make(3),
        role: "assistant",
        text: "Let me read it.",
        at: NOW,
      }),
    });

    Scene.scene(
      appFor(
        inputsOf(6, [shellRow(PARENT), stopped], {}, [
          modelEntry(2, { role: "user", content: "Read it.", timestamp: 2 }),
          modelEntry(3, {
            role: "assistant",
            content: [],
            stopReason: "toolUse",
            timestamp: 3,
          }),
        ])
      ),
      givenWork(),
      Scene.expect(Scene.testId("work-toggle")).toContainText("2/4 steps"),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="working"]')
      ).toHaveAttr("data-step-state", "stopped"),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="reported"]')
      ).toHaveAttr("data-step-state", "todo"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("marks a failed child's work failed", () => {
    const failed = childOf(6, "Read the README", {
      latestRunStartedAt: Option.some(EARLIER),
      activity: "failed",
      lastError: Option.some("The model could not read the README."),
    });

    Scene.scene(
      appFor(inputsOf(6, [shellRow(PARENT), failed])),
      givenWork(),
      Scene.expect(Scene.testId("work-toggle")).toContainText("2/4 steps"),
      Scene.expect(
        Scene.selector('[data-testid="work-step"][data-step="working"]')
      ).toHaveAttr("data-step-state", "failed"),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });
});

/** A ledger node as the brain writes it. */
const node = (index: number, overrides: { readonly state?: string } = {}) => ({
  id: `n-${String(index)}`,
  workflowId: "wf-1",
  key: null,
  label: `alpha:${String(index)}`,
  phase: "Alpha",
  index,
  requestId: `wf-wf-1-n-${String(index)}`,
  briefId: null,
  role: "@worker",
  provider: "faux",
  modelId: "kit",
  effort: null,
  readonly: false,
  arms: "host",
  state: "running",
  stage: "submitted",
  childThreadId: null,
  conversationId: null,
  submissionId: null,
  nestedTaskId: 100 + index,
  attempt: 1,
  schemaAttempts: 0,
  receipt: null,
  result: null,
  resultSummary: null,
  refusal: null,
  held: null,
  startedAt: null,
  endedAt: null,
  error: null,
  ...overrides,
});

const LEDGER: Schema.Json = {
  items: {
    "wf-1": {
      id: "wf-1",
      name: "council",
      description: "Ask two advisors",
      phases: [
        { title: "Alpha", detail: null },
        { title: "Beta", detail: null },
      ],
      scriptHash: "hash",
      scriptRef: "script-wf-1",
      args: {},
      state: "running",
      outcome: null,
      approvalId: "launch-wf-1",
      decidedBy: { kind: "user" },
      decidedAt: 1,
      sample: null,
      budget: {
        maxListMicros: null,
        maxTokens: null,
        maxTurns: null,
        maxMinutes: null,
        planGuard: null,
        warnAt: 0.8,
      },
      estimate: null,
      codemodeTaskId: 7,
      startedAt: 2,
      endedAt: null,
      result: null,
      nodes: {
        "n-1": node(1, { state: "settled" }),
        "n-2": node(2),
      },
      log: {},
      spent: { tokens: 0, listMicros: 0, unpricedTokens: 0 },
      softAt: null,
      spentAt: null,
    },
  },
};

describe("the work panel's workflows", () => {
  it("shows each workflow's tally, phases and nodes from the ledger", () => {
    const inputs = inputsOf(9, [shellRow(9)], { "cairn.workflows": LEDGER });

    assert.strictEqual(
      Option.map(inputs, workToggleText).pipe(Option.getOrThrow),
      "1 workflow"
    );

    Scene.scene(
      appFor(inputs),
      givenWork(),
      Scene.expect(Scene.testId("work-workflow")).toContainText("council"),
      Scene.expect(Scene.testId("work-workflow")).toContainText(
        "2 nodes · 1 working · 1 done"
      ),
      Scene.expectAll(
        Scene.all.selector('[data-testid="work-phase"]')
      ).toHaveCount(2),
      Scene.expect(
        Scene.selector('[data-testid="work-phase"][data-phase-state="running"]')
      ).toContainText("1/2"),
      Scene.expect(
        Scene.selector('[data-testid="work-phase"][data-phase-state="pending"]')
      ).toContainText("not started"),
      Scene.expectAll(
        Scene.all.selector('[data-testid="work-node"]')
      ).toHaveCount(2),
      Scene.expect(
        Scene.selector('[data-testid="work-node"][data-node-id="n-1"]')
      ).toContainText("@worker · faux/kit"),
      Scene.expect(Scene.testId("work-workflow")).toContainText(
        "Nothing spent yet"
      ),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("stops one live node, or the whole workflow, and shows Stopping until the stop answers", () => {
    const inputs = inputsOf(9, [shellRow(9)], { "cairn.workflows": LEDGER });
    const live = '[data-testid="work-node"][data-node-id="n-2"]';

    Scene.scene(
      appFor(inputs),
      givenWork(),
      // A settled node offers no Stop; the live one does.
      Scene.expectAll(
        Scene.all.selector('[data-testid="work-node-stop"]')
      ).toHaveCount(1),
      Scene.click(Scene.role("button", { name: "Stop alpha:2" })),
      expectSent("StopWorkflow:wf-1/n-2"),
      Scene.click(Scene.testId("work-workflow-stop")),
      expectSent("StopWorkflow:wf-1/n-2,StopWorkflow:wf-1")
    );

    // While a stop is out, the node says so and offers no second Stop; so does the workflow.
    Scene.scene(
      appFor(inputs),
      givenWork({ stoppingWork: ["wf-1/n-2"] }),
      Scene.expect(Scene.selector(live)).toHaveAttr("data-stopping", "true"),
      Scene.expect(Scene.selector(live)).toContainText("stopping"),
      Scene.expect(Scene.testId("work-node-stop")).not.toExist()
    );

    Scene.scene(
      appFor(inputs),
      givenWork({ stoppingWork: ["wf-1"] }),
      Scene.expect(Scene.testId("work-workflow-stop")).toContainText(
        "Stopping"
      ),
      Scene.expect(Scene.selector(live)).toHaveAttr("data-stopping", "true")
    );

    const asked = update(
      { ...initial, work: { ...initialWork, isOpen: true } },
      Message.ClickedStopWorkflow({
        threadId: rowId(9),
        workflowId: "wf-1",
        nodeId: Option.none(),
      })
    );

    assert.deepStrictEqual(asked.model.work.stoppingWork, ["wf-1"]);
    assert.strictEqual(asked.commands?.length, 1);

    // Asked twice, one stop goes; the answer clears it, a failure says why.
    const twice = update(
      asked.model,
      Message.ClickedStopWorkflow({
        threadId: rowId(9),
        workflowId: "wf-1",
        nodeId: Option.none(),
      })
    );

    assert.lengthOf(twice.commands ?? [], 0);

    const stopped = update(
      asked.model,
      Message.StoppedWorkflow({ key: "wf-1" })
    );

    assert.deepStrictEqual(stopped.model.work.stoppingWork, []);

    const failed = update(
      asked.model,
      Message.FailedStopWorkflow({ key: "wf-1", message: "Not reached." })
    );

    assert.deepStrictEqual(failed.model.work.stoppingWork, []);
    assert.deepStrictEqual(
      failed.model.work.failure,
      Option.some("Not reached.")
    );
  });
});

describe("the shell's update for the work panel", () => {
  const onParent = {
    ...initial,
    work: { ...initialWork, isOpen: true },
  };

  it("asks Stop once and remembers it until the child rests", () => {
    const first = update(
      onParent,
      Message.ClickedStopChild({ threadId: rowId(2) })
    );

    assert.deepStrictEqual(first.model.work.stopping, [rowId(2)]);
    assert.strictEqual(first.commands?.length, 1);

    const again = update(
      first.model,
      Message.ClickedStopChild({ threadId: rowId(2) })
    );

    assert.strictEqual(again.commands?.length ?? 0, 0);

    const contextWith = (threads: ReadonlyArray<ThreadShell>) => ({
      ...first.model.context,
      route: AppRoute.Thread({ threadId: rowId(PARENT) }),
      shell: Option.some(shellOf(threads)),
    });

    const stillRunning = inform(
      first.model,
      contextWith([shellRow(PARENT), childOf(2, "Count the files", working)])
    );

    assert.deepStrictEqual(stillRunning.model.work.stopping, [rowId(2)]);

    const rested = inform(
      stillRunning.model,
      contextWith([shellRow(PARENT), childOf(2, "Count the files", answered)])
    );

    assert.deepStrictEqual(rested.model.work.stopping, []);
  });

  it("clears Stopping once the stop answers, though the child still waits", () => {
    const waiting = childOf(2, "Count the files", {
      ...working,
      activity: "waiting",
      activeRunId: Option.none(),
    });

    const restarted = childOf(3, "Read the README", working);

    const context = {
      ...onParent.context,
      route: AppRoute.Thread({ threadId: rowId(PARENT) }),
      shell: Option.some(shellOf([shellRow(PARENT), waiting, restarted])),
    };

    const askedOne = update(
      inform(onParent, context).model,
      Message.ClickedStopChild({ threadId: rowId(2) })
    ).model;

    const asked = update(
      askedOne,
      Message.ClickedStopChild({ threadId: rowId(3) })
    ).model;

    assert.deepStrictEqual(asked.work.stopping, [rowId(2), rowId(3)]);

    const stoppedOne = update(
      asked,
      Message.StoppedChild({ threadId: rowId(2) })
    ).model;

    const stopped = update(
      stoppedOne,
      Message.StoppedChild({ threadId: rowId(3) })
    ).model;

    assert.deepStrictEqual(stopped.work.stopping, []);

    // A child whose queued input started a new run offers Stop again.
    Scene.scene(
      appFor(inputsOf(PARENT, [shellRow(PARENT), waiting, restarted])),
      givenWork(stopped.work),
      Scene.expect(child(2)).toContainText("Waiting"),
      Scene.expect(child(3)).toContainText("Working"),
      Scene.expect(
        Scene.role("button", { name: "Stop Read the README" })
      ).toExist(),
      Scene.tap(({ commands }) => {
        assert.lengthOf(commands, 0);
      })
    );
  });

  it("says why a Stop failed and offers it again", () => {
    const asked = update(
      onParent,
      Message.ClickedStopChild({ threadId: rowId(2) })
    ).model;

    const failed = update(
      asked,
      Message.FailedStopChild({
        threadId: rowId(2),
        message: "Cairn is reconnecting. Stop again once it is back.",
      })
    ).model;

    assert.deepStrictEqual(failed.work.stopping, []);
    assert.isTrue(Option.isSome(failed.work.failure));
    assert.isTrue(
      Option.isNone(
        update(failed, Message.ClickedDismissWorkFailure()).model.work.failure
      )
    );
  });

  it("toggles, pages and starts each thread at the first page", () => {
    const closed = update(onParent, Message.ClickedWork()).model;

    assert.isFalse(closed.work.isOpen);

    const paged = update(
      update(onParent, Message.ClickedMoreChildren({ group: "active" })).model,
      Message.ClickedPreviousChildren()
    ).model;

    assert.strictEqual(paged.work.shownActive, 18);
    assert.isTrue(paged.work.isPreviousOpen);

    const moved = inform(paged, {
      ...paged.context,
      route: AppRoute.Thread({ threadId: ThreadId.make(rowId(3)) }),
    }).model;

    assert.strictEqual(moved.work.shownActive, 6);
    assert.isFalse(moved.work.isPreviousOpen);
    assert.isTrue(moved.work.isOpen);
  });
});
