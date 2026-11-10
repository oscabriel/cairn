// The goal on a thread (plan wave 6, 6H; surfaces note S1; ADR 0026): a goal is a thread with
// criteria, the project thread first among them. The chat header's goal chip counts its criteria as
// the thread's `cairn.goal` records them ("2 of 4 met"), and opens the goal panel: the objective,
// the progress line (client-logic `GoalProgress.ts`), then each criterion with its state as mark
// and word, the judge that decides it, the verdict's evidence, and, on a criterion the user judges,
// Met and Not met, which send `goal.mark`.
//
// Nothing here decides a criterion: a state comes only from the verdict writer's record (a command
// run, a model of another family, or the user's own mark through `goal.mark`), read from the goal
// document the thread stream carries. A mark on its way shows its button busy, never the state it
// asks for.
//
// The Stone look, as the work panel draws it: colour only on the status marks; on the sheet,
// beside the chat column from `lg`, a modal sheet over a scrim below (a dialog), rows at least
// 44 px on a coarse pointer.

import {
  criterionStateLabel,
  evidenceLines,
  judgeChip,
  judgeWarning,
} from "@cairn/client-logic/GoalProgress";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { Criterion } from "@cairn/protocol/Policy";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Check, X } from "lucide";

import { button, buttonClass, buttonDefaults } from "../ui/Button.ts";
import { TYPE, WEIGHT_MEDIUM } from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { glyph } from "../ui/Glyph.ts";
import { modalSheet, sheetDefaults, sideColumn } from "../ui/Sheet.ts";
import type { SheetConfig } from "../ui/Sheet.ts";
import { GOAL_PANEL_ID, stateMark } from "./Goal.ts";
import type { GoalViewInputs } from "./Goal.ts";
import type { Message } from "./Message.ts";
import { Message as ShellMessage } from "./Message.ts";
import type { GoalPanelState } from "./Model.ts";

type H = HtmlBuilder<Message>;

// ---------------------------------------------------------------------------------------------
// Pieces

const small = (h: H, text: string, slot: string): Html =>
  h.span(
    [
      h.DataAttribute("slot", slot),
      h.Class(classNames("min-w-0 text-ink-3", TYPE.small)),
    ],
    [text]
  );

/** Met and Not met on a criterion the user judges; the one its verdict holds is pressed. */
const markButtons = (
  h: H,
  threadId: ThreadId,
  criterion: Criterion,
  isMarking: boolean
): Html => {
  const said = Option.map(
    Option.fromNullOr(criterion.verdict),
    (verdict) => verdict.ok
  );

  const markButton = (ok: boolean, label: string, icon: Html) =>
    button(
      h,
      {
        ...buttonDefaults<Message>(),
        size: "small",
        isBusy: isMarking,
        isPressed: Option.some(Option.contains(said, ok)),
        ariaLabel: Option.some(`${label}: ${criterion.text}`),
        onClick: Option.some(
          ShellMessage.ClickedMarkCriterion({
            threadId,
            criterionId: criterion.id,
            ok,
          })
        ),
        attributes: [
          h.DataAttribute("testid", ok ? "goal-mark-met" : "goal-mark-not-met"),
        ],
      },
      [icon, label]
    );

  return h.div(
    [
      h.DataAttribute("slot", "goal-marks"),
      h.Class("flex flex-wrap items-center gap-(--space-2)"),
    ],
    [
      markButton(true, "Met", glyph(h, Check, "check", "small")),
      markButton(false, "Not met", glyph(h, X, "x", "small")),
    ]
  );
};

/** The verdict's evidence: who decided and how, the command's exit and output, the model's reply. */
const evidence = (h: H, criterion: Criterion): Html =>
  Option.match(Option.fromNullOr(criterion.verdict), {
    onNone: () => h.empty,
    onSome: (verdict) =>
      h.div(
        [
          h.DataAttribute("testid", "goal-evidence"),
          h.Class(
            classNames(
              "max-h-32 min-w-0 overflow-y-auto whitespace-pre-wrap break-words rounded-(--radius-small) border border-stroke-1 bg-surface-raised px-(--space-2) py-(--space-1) text-ink-2",
              TYPE.small
            )
          ),
        ],
        evidenceLines(verdict).map((line) => h.div([], [line]))
      ),
  });

const criterionRow = (
  h: H,
  threadId: ThreadId,
  criterion: Criterion,
  panel: GoalPanelState
): Html => {
  const label = criterionStateLabel(criterion.state);
  const warning = judgeWarning(criterion.judge);

  return h.li(
    [
      h.DataAttribute("testid", "goal-criterion"),
      h.DataAttribute("criterion-id", criterion.id),
      h.DataAttribute("state", criterion.state),
      h.DataAttribute("judge", criterion.judge.kind),
      h.Class(
        "flex min-w-0 flex-col gap-(--space-1-5) border-b border-stroke-1 px-(--space-2) py-(--space-2) last:border-b-0"
      ),
    ],
    [
      h.div(
        [h.Class("flex min-h-7 min-w-0 items-start gap-(--space-2)")],
        [
          stateMark(h, criterion.state),
          h.span(
            [
              h.DataAttribute("slot", "goal-criterion-text"),
              h.Class(
                classNames(
                  "min-w-0 flex-1 break-words text-ink-1",
                  TYPE.ui,
                  WEIGHT_MEDIUM
                )
              ),
            ],
            [criterion.text]
          ),
          h.span(
            [
              h.DataAttribute("slot", "goal-criterion-state"),
              h.Class(
                classNames("shrink-0 whitespace-nowrap text-ink-2", TYPE.small)
              ),
            ],
            [label.word]
          ),
        ]
      ),
      h.div(
        [h.Class("flex min-w-0 flex-col gap-(--space-1) ps-(--space-6)")],
        [
          small(h, `Judged by ${judgeChip(criterion.judge)}`, "goal-judge"),
          Option.match(warning, {
            onNone: () => h.empty,
            onSome: (text) => small(h, text, "goal-judge-warning"),
          }),
          evidence(h, criterion),
          criterion.judge.kind === "user"
            ? markButtons(
                h,
                threadId,
                criterion,
                panel.marking.includes(criterion.id)
              )
            : h.empty,
        ]
      ),
    ]
  );
};

const failureLine = (h: H, failure: string): Html =>
  h.div(
    [
      h.DataAttribute("testid", "goal-failure"),
      h.Role("alert"),
      h.Class(
        classNames(
          "flex min-w-0 items-start gap-(--space-2) rounded-(--radius-small) border border-stroke-1 px-(--space-2) py-(--space-1-5) text-ink-1",
          TYPE.small
        )
      ),
    ],
    [
      stateMark(h, "failed"),
      h.span([h.Class("min-w-0 flex-1")], [failure]),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ShellMessage.ClickedDismissGoalFailure()),
          h.Class(buttonClass("ghost", "small")),
        ],
        ["Dismiss"]
      ),
    ]
  );

// ---------------------------------------------------------------------------------------------
// The panel

/**
 * The goal panel while it is open, on the sheet as the work panel is: under `lg` a modal
 * sheet over a scrim, from `lg` a column beside the chat. Nothing while closed, or off a thread
 * with criteria.
 */
export const goalPanelView = Submodel.defineView<
  GoalPanelState,
  Message,
  GoalViewInputs
>((panel, { inputs, isWide }, h) => {
  if (!panel.isOpen || Option.isNone(inputs)) {
    return h.empty;
  }

  const { threadId, goal, progress } = inputs.value;

  const config: SheetConfig<Message> = {
    ...sheetDefaults<Message>(GOAL_PANEL_ID, "Goal"),
    layout: "list",
    closeLabel: "Close the goal panel",
    attributes: [h.DataAttribute("testid", "goal-panel")],
    scrimAttributes: [h.DataAttribute("testid", "goal-scrim")],
    closeAttributes: [h.DataAttribute("testid", "goal-close")],
  };

  const body = [
    Option.match(panel.failure, {
      onNone: () => h.empty,
      onSome: (failure) => failureLine(h, failure),
    }),
    goal.objective === ""
      ? h.empty
      : h.p(
          [
            h.DataAttribute("testid", "goal-objective"),
            h.Class(
              classNames(
                "min-w-0 break-words px-(--space-2) text-ink-1",
                TYPE.body
              )
            ),
          ],
          [goal.objective]
        ),
    h.p(
      [
        h.DataAttribute("testid", "goal-progress"),
        h.Class(classNames("min-w-0 px-(--space-2) text-ink-2", TYPE.small)),
      ],
      [progress.line]
    ),
    h.ul(
      [
        h.DataAttribute("testid", "goal-criteria"),
        h.AriaLabel("Criteria"),
        h.Class(
          "flex min-w-0 flex-col rounded-(--radius-medium) border border-stroke-1 bg-surface-raised"
        ),
      ],
      goal.criteria.map((criterion) =>
        criterionRow(h, threadId, criterion, panel)
      )
    ),
  ];

  return isWide
    ? sideColumn(
        h,
        { ...config, onClose: Option.some(ShellMessage.ClickedCloseGoal()) },
        body,
        []
      )
    : modalSheet(
        h,
        {
          ...config,
          role: "dialog",
          focusSelector: Option.none(),
          onClose: ShellMessage.ClickedCloseGoal(),
          onSettled: ShellMessage.SettledOverlay(),
        },
        body,
        []
      );
});
