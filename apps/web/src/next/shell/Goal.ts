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
// The Stone look, as the work panel draws it: colour only on the status marks; beside the chat
// column from `lg`, a bottom sheet over a scrim below, rows at least 44 px on a coarse pointer. Its
// utilities are built by `shell.css`, into the `next` chunk.

import type { GoalProgress } from "@cairn/client-logic/GoalProgress";
import {
  criterionStateLabel,
  evidenceLines,
  goalOf,
  goalProgress,
  goalTallyOf,
  goalTallyState,
  goalTallyText,
  isGoal,
  judgeChip,
  judgeWarning,
} from "@cairn/client-logic/GoalProgress";
import { approvalRecordsOf } from "@cairn/client-logic/PendingRequests";
import { ThreadId } from "@cairn/protocol/Ids";
import { APPROVALS_DOCUMENT, GOAL_DOCUMENT } from "@cairn/protocol/Policy";
import type {
  Criterion,
  CriterionState,
  GoalDocument,
} from "@cairn/protocol/Policy";
import type { GoalTally, ShellSnapshot } from "@cairn/protocol/Shell";
import { Option, Predicate } from "effect";
import type { Schema } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Check, Target, X } from "lucide";

import type { Model } from "../../Model.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { button, buttonClass, buttonDefaults } from "../ui/Button.ts";
import { TYPE, WEIGHT_MEDIUM, WEIGHT_STRONG } from "../ui/Classes.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { glyph, statusGlyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";
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
const stateMark = (h: H, state: CriterionState): Html =>
  h.span(
    [
      h.Class(
        classNames("inline-flex shrink-0", TONE_TEXT[STATE_LOOK[state].tone])
      ),
    ],
    [statusGlyph(h, STATE_LOOK[state].mark, "regular")]
  );

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
// The header's chip and the panel

/** What the header's chip and the panel are drawn from: the routed thread's goal. */
export interface GoalViewInputs {
  readonly inputs: Option.Option<GoalInputs>;
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

// Each placement's classes carry their own breakpoint, as the work panel's do.
const PANEL = classNames(
  "flex min-w-0 flex-col overflow-hidden border-stroke-1 text-ink-1",
  "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-(--layer-sheet) max-lg:max-h-[85dvh] max-lg:rounded-t-(--radius-large) max-lg:border-t max-lg:bg-surface-overlay max-lg:pb-[env(safe-area-inset-bottom)] max-lg:shadow-(--elevation-3)",
  "lg:w-[22rem] lg:shrink-0 lg:border-l lg:bg-surface-ground"
);

/**
 * The goal panel while it is open: a scrim and a bottom sheet under `lg`, a column beside the chat
 * from `lg`. Nothing while closed, or off a thread with criteria.
 */
export const goalPanelView = Submodel.defineView<
  GoalPanelState,
  Message,
  GoalViewInputs
>((panel, { inputs }, h) => {
  if (!panel.isOpen || Option.isNone(inputs)) {
    return h.empty;
  }

  const { threadId, goal, progress } = inputs.value;

  return h.div(
    [h.DataAttribute("slot", "goal"), h.Class("contents")],
    [
      h.div([
        h.DataAttribute("testid", "goal-scrim"),
        h.AriaHidden(true),
        h.OnClick(ShellMessage.ClickedCloseGoal()),
        h.Class(
          "max-lg:fixed max-lg:inset-0 max-lg:z-(--layer-scrim) max-lg:bg-scrim lg:hidden"
        ),
      ]),
      h.aside(
        [
          h.Id(GOAL_PANEL_ID),
          h.DataAttribute("testid", "goal-panel"),
          h.AriaLabelledBy(`${GOAL_PANEL_ID}-title`),
          h.Class(PANEL),
        ],
        [
          h.div([
            h.AriaHidden(true),
            h.Class(
              "mx-auto mt-(--space-2) h-1 w-9 shrink-0 rounded-(--radius-round) bg-stroke-2 lg:hidden"
            ),
          ]),
          h.header(
            [
              h.Class(
                "flex min-h-13 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 py-(--space-2) ps-(--space-4) pe-(--space-2) lg:min-h-14"
              ),
            ],
            [
              h.h2(
                [
                  h.Id(`${GOAL_PANEL_ID}-title`),
                  h.Class(
                    classNames(
                      "min-w-0 flex-1 truncate",
                      TYPE.title,
                      WEIGHT_STRONG
                    )
                  ),
                ],
                ["Goal"]
              ),
              iconButton(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost",
                  label: "Close the goal panel",
                  onClick: Option.some(ShellMessage.ClickedCloseGoal()),
                  attributes: [h.DataAttribute("testid", "goal-close")],
                },
                glyph(h, X, "x", "regular")
              ),
            ]
          ),
          h.div(
            [
              h.DataAttribute("slot", "goal-body"),
              h.Class(
                "flex min-h-0 flex-1 flex-col gap-(--space-3) overflow-y-auto overscroll-contain p-(--space-2)"
              ),
            ],
            [
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
                  h.Class(
                    classNames("min-w-0 px-(--space-2) text-ink-2", TYPE.small)
                  ),
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
            ]
          ),
        ]
      ),
    ]
  );
});
