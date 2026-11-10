// The goal on a thread (plan wave 6, 6H; surfaces note S1; ADR 0026): a goal is a thread with
// criteria, the project thread first among them. This module reads the goal from the thread's
// documents and draws the chat header's goal chip, which counts its criteria as the thread's
// `cairn.goal` records them ("2 of 4 met") and opens the goal panel. The panel itself is
// `GoalPanel.ts`, its own chunk: a cold load never draws it (`next/page/Chunks.ts`).

import type { GoalProgress } from "@cairn/client-logic/GoalProgress";
import {
  goalOf,
  goalProgress,
  goalTallyOf,
  goalTallyState,
  goalTallyText,
  isGoal,
} from "@cairn/client-logic/GoalProgress";
import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import { ThreadId } from "@cairn/protocol/Ids";
import { APPROVALS_DOCUMENT, GOAL_DOCUMENT } from "@cairn/protocol/Policy";
import type { CriterionState, GoalDocument } from "@cairn/protocol/Policy";
import type { GoalTally, ShellSnapshot } from "@cairn/protocol/Shell";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Target } from "lucide";

import type { Model } from "../../Model.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { buttonClass } from "../ui/Button.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { glyph, statusGlyph } from "../ui/Glyph.ts";
import type { Tone } from "../ui/Tone.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { Message } from "./Message.ts";
import { Message as ShellMessage } from "./Message.ts";
import type { GoalPanelState } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** The panel's id, which the header's chip controls. */
export const GOAL_PANEL_ID = "goal-panel";

// ---------------------------------------------------------------------------------------------
// What the chip and the panel read

/** The goal of the open thread, as its documents hold it. */
export interface GoalInputs {
  readonly threadId: ThreadId;
  readonly goal: GoalDocument;
  /** The criteria counted from the goal document: what the chip says. */
  readonly tally: GoalTally;
  readonly progress: GoalProgress;
}

interface Memo {
  readonly shell: ShellSnapshot;
  readonly threadId: string;
  readonly goal: Schema.Json | undefined;
  readonly approvals: Schema.Json | undefined;
  readonly inputs: Option.Option<GoalInputs>;
}

// One entry: the inputs last derived, kept while the shell and the documents they read are the
// same objects, so a keystroke in the composer derives nothing and the chip keeps its drawing. Held
// outside the Model on purpose, as the work panel's memo is.
const memo = new Map<"last", Memo>();

const NO_DOCS: Readonly<Record<string, Schema.Json>> = {};

const deriveInputs = (
  shell: ShellSnapshot,
  threadId: ThreadId,
  docs: Readonly<Record<string, Schema.Json>>
): Option.Option<GoalInputs> => {
  const goal = goalOf(docs[GOAL_DOCUMENT]);

  if (!isGoal(goal)) {
    return Option.none();
  }

  return Option.map(
    Option.all({ found: goal, tally: goalTallyOf(goal) }),
    ({ found, tally }) => ({
      threadId,
      goal: found,
      tally,
      progress: goalProgress(
        threadId,
        goal,
        shell.threads,
        approvalRecordsOf(docs[APPROVALS_DOCUMENT])
      ),
    })
  );
};

/**
 * The goal the routed thread holds; none off a thread's page, or for a thread with no criteria.
 * The thread page's documents count only once they are the routed thread's.
 */
export const goalInputsOf = (
  model: Pick<Model, "route" | "shell"> & {
    readonly thread: Pick<Model["thread"], "threadId" | "view">;
  }
): Option.Option<GoalInputs> => {
  const { route } = model;

  if (!Predicate.isTagged(route, "Thread") || Option.isNone(model.shell)) {
    return Option.none();
  }

  const threadId = ThreadId.make(route.threadId);
  const shell = model.shell.value;

  const docs = Option.match(
    Option.filter(model.thread.view, () =>
      Option.contains(model.thread.threadId, threadId)
    ),
    { onNone: () => NO_DOCS, onSome: (state) => state.view.docs }
  );

  const goal = docs[GOAL_DOCUMENT];
  const approvals = docs[APPROVALS_DOCUMENT];
  const last = memo.get("last");

  if (
    last?.shell === shell &&
    last.threadId === threadId &&
    last.goal === goal &&
    last.approvals === approvals
  ) {
    return last.inputs;
  }

  const inputs = deriveInputs(shell, threadId, docs);

  memo.set("last", { shell, threadId, goal, approvals, inputs });

  return inputs;
};

// ---------------------------------------------------------------------------------------------
// Pieces

const STATE_LOOK: Readonly<
  Record<CriterionState, { readonly tone: Tone; readonly mark: StatusMark }>
> = {
  met: { tone: "done", mark: "done" },
  failed: { tone: "failed", mark: "failed" },
  open: { tone: "neutral", mark: "todo" },
};

/** A criterion's or the goal's state as its mark, in its tone: the only colour the panel draws. */
export const stateMark = (h: H, state: CriterionState): Html =>
  h.span(
    [
      h.Class(
        classNames("inline-flex shrink-0", TONE_TEXT[STATE_LOOK[state].tone])
      ),
    ],
    [statusGlyph(h, STATE_LOOK[state].mark, "regular")]
  );

// ---------------------------------------------------------------------------------------------
// The header's chip and the panel

/** What the header's chip and the panel are drawn from: the routed thread's goal. */
export interface GoalViewInputs {
  readonly inputs: Option.Option<GoalInputs>;
  /** The window is `lg` or wider: the panel is a column beside the chat, not a modal sheet. */
  readonly isWide: boolean;
}

/**
 * The chat header's goal chip, on a thread with criteria: its met count as the goal document
 * records it ("2 of 4 met"; "2/4" on a phone), its mark summing the goal. It shows or hides the
 * panel.
 */
export const goalChipView = Submodel.defineView<
  GoalPanelState,
  Message,
  GoalViewInputs
>((panel, { inputs }, h) =>
  Option.match(inputs, {
    onNone: () => h.empty,
    onSome: ({ tally }) =>
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "goal-chip"),
          h.DataAttribute("slot", "button"),
          h.DataAttribute("met", String(tally.met)),
          h.DataAttribute("total", String(tally.total)),
          h.DataAttribute("state", goalTallyState(tally)),
          h.AriaExpanded(panel.isOpen),
          h.AriaControls(GOAL_PANEL_ID),
          h.AriaLabel(`Goal: ${goalTallyText(tally)}`),
          h.OnClick(ShellMessage.ClickedGoal()),
          h.Class(classNames(buttonClass("secondary", "small"), "shrink-0")),
        ],
        [
          tally.met === tally.total || tally.failed > 0
            ? stateMark(h, goalTallyState(tally))
            : h.span(
                [h.Class("inline-flex shrink-0 text-ink-2")],
                [glyph(h, Target, "target", "small")]
              ),
          h.span(
            [
              h.DataAttribute("slot", "goal-chip-count"),
              h.Class("tabular-nums"),
            ],
            [
              h.span(
                [h.Class("sm:hidden")],
                [`${String(tally.met)}/${String(tally.total)}`]
              ),
              h.span(
                [h.Class("max-sm:hidden")],
                [
                  `${String(tally.met)} of ${String(tally.total)} met${tally.failed > 0 ? `, ${String(tally.failed)} not met` : ""}`,
                ]
              ),
            ]
          ),
        ]
      ),
  })
);
