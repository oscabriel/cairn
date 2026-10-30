// Scene tests for the transcript's subagent rows (plan 6C), drawn through the transcript's own row
// view from a parent's view as the wire projects it: the group sits after the work that spawned
// it and before the model's next words, a group of three folds behind one line that toggles
// through the transcript's own Message, a started child's row links to its thread with its state
// from its shell row, a group with nothing live dims, the way back heads a child's transcript
// below the history control, and classic (no shell rows passed) makes no subagent item at all.

import { shellRow } from "@cairn/client-logic/ShellRowTestKit";
import type { SubagentRequest } from "@cairn/client-logic/SubagentRollup";
import type { ThreadViewState } from "@cairn/client-logic/ThreadView";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { ConversationView } from "@cairn/protocol/Thread";
import { Option, Predicate, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import * as Scene from "foldkit/scene";
import { describe, expect, it } from "vitest";

import type { Message } from "../../timeline/Message.ts";
import { freshUi } from "../../timeline/Model.ts";
import type { ThreadUi } from "../../timeline/Model.ts";
import { transcriptOf } from "../../timeline/Rows.ts";
import type { ListItem } from "../../timeline/Rows.ts";
import { rowView } from "../../timeline/RowView.ts";
import type { SubagentShells } from "../../timeline/Subagents.ts";
import {
  subagentShellsOf,
  withSubagentItems,
} from "../../timeline/Subagents.ts";
// Registers the views the row frame draws, as the `next` chunk does when it loads.
import "./SubagentRows.ts";

const PARENT = ThreadId.make("01890a5d-ac96-774b-bcce-b302099a0001");

const childId = (n: number) =>
  ThreadId.make(
    `01890a5d-ac96-774b-bcce-b302099a${String(n).padStart(4, "0")}`
  );

const DESCRIPTIONS = ["Count the files", "Read the README", "List the docs"];

const brief = (index: number, fields: Record<string, Schema.Json>) => ({
  id: `call-${String(index)}`,
  toolTaskId: index,
  tool: "subagent_spawn",
  kind: "brief",
  summary: DESCRIPTIONS[index] ?? "",
  status: "pending",
  askedAt: 1001 + index,
  expiresAt: 9000,
  answeredAt: null,
  run: null,
  executorRequestId: null,
  payload: null,
  answer: null,
  decidedBy: null,
  reason: null,
  route: "user",
  escalatedAt: null,
  supersedes: null,
  started: null,
  briefHash: null,
  mirrorOf: null,
  ...fields,
});

const registryItem = (index: number, fields: Record<string, Schema.Json>) => ({
  threadId: childId(11 + index),
  conversationId: 2 + index,
  anchorTaskId: 7,
  briefApprovalId: `call-${String(index)}`,
  description: DESCRIPTIONS[index] ?? "",
  dispatch: { spec: null, resolved: null, previewed: null, dispatchedAt: 2000 },
  isolation: "shared",
  worktree: null,
  status: "working",
  wake: "answer",
  settlements: [],
  runs: [],
  delivered: 0,
  questions: {},
  inputs: {},
  ...fields,
});

const SETTLED = {
  status: "settled",
  settlements: [
    {
      seq: 1,
      outcome: "completed",
      answerEntry: 9,
      reportedAt: 14_000,
      inputs: [],
    },
  ],
  delivered: 1,
};

/** A parent that asked for three children in one step, then said so, with `docs` beside it. */
const parentView = (docs: Record<string, Schema.Json>) =>
  Schema.decodeSync(ConversationView)({
    conversation: { id: 1 },
    entries: [
      {
        id: 1,
        conversationId: 1,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [{ type: "text", text: "delegate it" }],
            timestamp: 900,
          },
        ],
      },
      {
        id: 2,
        conversationId: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: DESCRIPTIONS.map((description, index) => ({
              type: "toolCall",
              id: `c${String(index)}`,
              name: "subagent_spawn",
              arguments: { description, brief: "Do it." },
            })),
            stopReason: "toolUse",
            timestamp: 1000,
          },
        ],
      },
      ...DESCRIPTIONS.map((_, index) => ({
        id: 3 + index,
        conversationId: 1,
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: `c${String(index)}`,
            toolName: "subagent_spawn",
            content: [
              { type: "text", text: "The brief is waiting for the user's Go." },
            ],
            isError: false,
            timestamp: 1001 + index,
          },
        ],
      })),
      {
        id: 6,
        conversationId: 1,
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Waiting for Go." }],
            stopReason: "stop",
            timestamp: 1100,
          },
        ],
      },
    ],
    docs,
  });

const stateOf = (
  view: ConversationView,
  hasMoreHistory = false
): ThreadViewState => ({
  seq: 0,
  view,
  entriesOffset: 0,
  hasMoreHistory,
  older: [],
});

const shellsOf = (
  rows: ReadonlyArray<ThreadShell>,
  requests: ReadonlyArray<readonly [ThreadId, SubagentRequest]> = []
): SubagentShells => ({
  children: new Map(rows.map((row) => [row.id, row] as const)),
  requests: new Map(requests),
  parentTitle: Option.some("Plan the port"),
});

const itemsOf = (
  state: ThreadViewState,
  ui: ThreadUi
): ReadonlyArray<ListItem> =>
  withSubagentItems(
    transcriptOf(PARENT, Option.some(state), ui, Option.none()).items,
    Option.some(state),
    ui
  );

const groupOf = (items: ReadonlyArray<ListItem>): ListItem => {
  const group = items.find((item) => item.kind === "subagents");

  if (group === undefined) {
    throw new Error("no subagent group");
  }

  return group;
};

interface Sent {
  readonly sent: ReadonlyArray<string>;
}

const app = (item: ListItem, shells: SubagentShells) => ({
  update: (model: Sent, message: Message) => ({
    model: {
      sent: [
        ...model.sent,
        Predicate.isTagged(message, "ToggledWorkGroup")
          ? message.groupId
          : message._tag,
      ],
    },
  }),
  view: (model: Sent, h: HtmlBuilder<Message>): Html =>
    h.div(
      [],
      [
        rowView(h, item, {
          threadId: PARENT,
          workspaceRoot: Option.none(),
          highlightedLanguages: [],
          highlightedCode: 0,
          copiedRowId: Option.none(),
          expanded: false,
          retryPrompt: Option.none(),
          history: "idle",
          historyCursor: Option.none(),
          subagents: Option.some(shells),
        }),
        h.output([h.DataAttribute("testid", "sent")], [model.sent.join(",")]),
      ]
    ),
});

const given = Scene.given<Sent>({ sent: [] });

const ui = freshUi(Option.some(PARENT));

describe("the subagent rows", () => {
  it("place one group after the spawning step and before the model's next words", () => {
    const items = itemsOf(
      stateOf(
        parentView({
          "cairn.approvals": {
            items: Object.fromEntries(
              [0, 1, 2].map((i) => [`call-${String(i)}`, brief(i, {})])
            ),
          },
        })
      ),
      ui
    );

    const kinds = items.map((item) => item.kind);
    const group = kinds.indexOf("subagents");

    const answer = items.findIndex(
      (item) =>
        item.kind === "message" && item.message.text === "Waiting for Go."
    );

    expect(kinds.filter((kind) => kind === "subagents")).toHaveLength(1);
    expect(group).toBeGreaterThan(0);
    expect(group).toBeLessThan(answer);
    expect(
      items.slice(group + 1, answer).every((item) => item.kind !== "work")
    ).toBeTruthy();
  });

  it("folds three children behind one line that toggles through the transcript", () => {
    const item = groupOf(
      itemsOf(
        stateOf(
          parentView({
            "cairn.approvals": {
              items: Object.fromEntries(
                [0, 1, 2].map((i) => [`call-${String(i)}`, brief(i, {})])
              ),
            },
          })
        ),
        ui
      )
    );

    Scene.scene(
      app(item, shellsOf([])),
      given,
      Scene.expect(Scene.testId("subagent-group")).toHaveAttr(
        "data-count",
        "3"
      ),
      Scene.expect(Scene.testId("subagent-group")).toHaveAttr(
        "data-active",
        "true"
      ),
      Scene.expect(Scene.testId("subagent-group-toggle")).toContainText(
        "3 subagents"
      ),
      Scene.expect(Scene.selector('[data-slot="subagent-tally"]')).toHaveText(
        "3 need you"
      ),
      Scene.expect(Scene.testId("subagent-row")).not.toExist(),
      Scene.click(Scene.testId("subagent-group-toggle")),
      Scene.expect(Scene.testId("sent")).toHaveText("subagents:c0"),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("links each started child to its thread, its state from its own row", () => {
    const view = parentView({
      "cairn.approvals": {
        items: Object.fromEntries(
          [0, 1, 2].map((i) => [
            `call-${String(i)}`,
            brief(i, {
              status: "accepted",
              started: { childThreadId: childId(11 + i) },
            }),
          ])
        ),
      },
      "cairn.subagents": {
        items: {
          a: registryItem(0, SETTLED),
          b: registryItem(1, {}),
          c: registryItem(2, {}),
        },
      },
    });

    const expanded = { ...ui, expandedWorkGroupIds: ["subagents:c0"] };
    const item = groupOf(itemsOf(stateOf(view), expanded));

    const shells = shellsOf([
      shellRow(11),
      shellRow(12, { activity: "running" }),
      shellRow(13, { activity: "failed", lastError: Option.some("boom") }),
    ]);

    Scene.scene(
      app(item, shells),
      given,
      Scene.expectAll(Scene.all.testId("subagent-row")).toHaveCount(3),
      Scene.expect(
        Scene.selector(`[data-child-thread-id="${childId(11)}"]`)
      ).toHaveAttr("href", `/t/${childId(11)}`),
      Scene.expect(
        Scene.selector(`[data-child-thread-id="${childId(11)}"]`)
      ).toHaveAttr("data-state", "done"),
      Scene.expect(
        Scene.selector(`[data-child-thread-id="${childId(12)}"]`)
      ).toHaveAttr("data-state", "working"),
      Scene.expect(
        Scene.selector(`[data-child-thread-id="${childId(13)}"]`)
      ).toHaveAttr("data-state", "failed"),
      Scene.expect(Scene.selector('[data-slot="subagent-tally"]')).toHaveText(
        "1 working · 1 done · 1 failed"
      ),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("dims a folded group once none of its children works", () => {
    const view = parentView({
      "cairn.approvals": {
        items: Object.fromEntries(
          [0, 1, 2].map((i) => [
            `call-${String(i)}`,
            brief(i, { status: "accepted" }),
          ])
        ),
      },
      "cairn.subagents": {
        items: {
          a: registryItem(0, SETTLED),
          b: registryItem(1, SETTLED),
          c: registryItem(2, SETTLED),
        },
      },
    });

    Scene.scene(
      app(
        groupOf(itemsOf(stateOf(view), ui)),
        shellsOf([shellRow(11), shellRow(12), shellRow(13)])
      ),
      given,
      Scene.expect(Scene.testId("subagent-group")).toHaveAttr(
        "data-active",
        "false"
      ),
      Scene.expect(Scene.testId("subagent-group")).toHaveClass("text-ink-3"),
      Scene.expect(Scene.selector('[data-slot="subagent-tally"]')).toHaveText(
        "3 done"
      ),
      Scene.expect(Scene.selector('[data-slot="subagent-meta"]')).toHaveText(
        "12s"
      ),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("heads a child's transcript with the way back, below the history control", () => {
    const view = Schema.decodeSync(ConversationView)({
      conversation: { id: 2 },
      entries: [],
      docs: {
        "cairn.child": {
          key: "call-0",
          parentThreadId: PARENT,
          parentConversationId: 1,
          rootThreadId: PARENT,
          depth: 1,
        },
      },
    });

    const items = itemsOf(
      stateOf(view, true),
      freshUi(Option.some(childId(11)))
    );

    expect(items.map((item) => item.kind)).toStrictEqual([
      "history",
      "parent-link",
    ]);

    const [, link] = items;

    if (link === undefined) {
      throw new Error("no way back");
    }

    Scene.scene(
      app(link, shellsOf([])),
      given,
      Scene.expect(Scene.testId("subagent-parent-link")).toHaveAttr(
        "href",
        `/t/${PARENT}`
      ),
      Scene.expect(Scene.selector('[data-slot="parent-title"]')).toHaveText(
        "Plan the port"
      ),
      Scene.expect(Scene.selector('[data-slot="parent-title"]')).toHaveClass(
        "truncate"
      )
    );
  });

  it("draws nothing for a subagent item without the shell rows, as on classic", () => {
    const item = groupOf(
      itemsOf(
        stateOf(
          parentView({
            "cairn.approvals": {
              items: Object.fromEntries(
                [0, 1, 2].map((i) => [`call-${String(i)}`, brief(i, {})])
              ),
            },
          })
        ),
        ui
      )
    );

    Scene.scene(
      {
        update: (model: Sent) => ({ model }),
        view: (_model: Sent, h: HtmlBuilder<Message>): Html =>
          rowView(h, item, {
            threadId: PARENT,
            workspaceRoot: Option.none(),
            highlightedLanguages: [],
            highlightedCode: 0,
            copiedRowId: Option.none(),
            expanded: false,
            retryPrompt: Option.none(),
            history: "idle",
            historyCursor: Option.none(),
            subagents: Option.none(),
          }),
      },
      given,
      Scene.expect(Scene.testId("subagent-group")).not.toExist(),
      Scene.tap(({ commands }) => {
        expect(commands).toHaveLength(0);
      })
    );
  });

  it("keeps one array while nothing it reads changed", () => {
    const state = stateOf(parentView({}));

    const base = transcriptOf(
      PARENT,
      Option.some(state),
      ui,
      Option.none()
    ).items;

    expect(withSubagentItems(base, Option.some(state), ui)).toBe(
      withSubagentItems(base, Option.some(state), ui)
    );
  });
});

describe("the shell rows the subagent rows read", () => {
  it("narrows to the open thread's children and keeps one object while they are unchanged", () => {
    const parent = shellRow(1, { title: "Plan the port" });

    const lineage = Option.some({
      parentThreadId: parent.id,
      relationshipToParent: "subagent" as const,
      rootThreadId: parent.id,
    });

    const child = shellRow(11, { lineage });
    const other = shellRow(5);

    const snapshot = {
      snapshotSequence: 1,
      projects: [],
      threads: [parent, child, other],
    };

    const first = subagentShellsOf(Option.some(snapshot), parent.id);

    expect([...first.children.keys()]).toStrictEqual([child.id]);

    // An unrelated row changed: the same object.
    const second = subagentShellsOf(
      Option.some({
        ...snapshot,
        threads: [parent, child, shellRow(5, { title: "Renamed" })],
      }),
      parent.id
    );

    expect(second).toBe(first);

    const third = subagentShellsOf(
      Option.some({
        ...snapshot,
        threads: [
          parent,
          shellRow(11, { lineage, activity: "running" }),
          other,
        ],
      }),
      parent.id
    );

    expect(third).not.toBe(first);

    // From the child: its parent's title for the way back.
    expect(
      subagentShellsOf(Option.some(snapshot), child.id).parentTitle
    ).toStrictEqual(Option.some("Plan the port"));
  });
});
