// The work panel (plan wave 6, 6E; surfaces notes S5 and S7): for a thread in a tree, its lineage
// and its steps, beside the transcript at 1,024 px and up and as a bottom sheet below that, opened
// from the chat header's work button.
//
// - Lineage: the way up (the parent, then its parent, each a link) and the thread's children, the
//   live ones first with Stop beside each and the resting ones under "Previous", folded, six rows
//   then twelve more per "Show more" (t3code's lineage panel, `ThreadRelationshipsControl.tsx`).
//   A child's state is the one thread-state function's (client-logic `ThreadLineage.ts`), drawn in
//   the one state table's word and mark (`STATE_LOOKS`, U-14). A row's Stop says "Stop" beside the
//   composer's Stop glyph; nothing undoes it, so its first press asks "Stop?" in place (U-3).
// - Steps: on a subagent's own page, its steps from Go to its answer (`SubagentSteps.ts`), which the
//   header's button counts ("2/4 steps").
// - Workflows: each workflow of the thread's dispatch ledger as the steps panel reads it
//   (`WorkflowSteps.ts`): its heading, tally and what it spent, its phases with their nodes, each
//   node with its model and outcome (`WorkflowPanel.ts`, 6F). Stop workflow while it may run
//   nodes (`workflow.stop`), and Stop on each live node of a running one (`workflow.stopNode`; the
//   script reads it as `null`); Stopping until the stop answers.
//
// The Stone look: colour only on the status marks; every word is ink. The panel is the
// sheet (`ui/Sheet.ts`): drawn beside the chat column, never over it, from `lg`; under `lg` a
// modal sheet over a scrim (a dialog: focus moves in and back, Escape closes it, the page behind is
// inert), at most 85% of the viewport tall, its body scrolling on its own. Nothing in it moves the
// transcript: on a wide screen it is its own column, on a phone it floats.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type {
  ChildStep,
  ChildStepState,
} from "@cairn/client-logic/SubagentSteps";
import { doneStepCount } from "@cairn/client-logic/SubagentSteps";
import type {
  Lineage,
  LineageAncestor,
  LineageChild,
} from "@cairn/client-logic/ThreadLineage";
import {
  isStoppableChildStatus,
  lineageWindow,
  showMoreCount,
} from "@cairn/client-logic/ThreadLineage";
import { STATE_LOOKS } from "@cairn/client-logic/ThreadState";
import type { StateLook } from "@cairn/client-logic/ThreadState";
import {
  isStoppableNode,
  isStoppableWorkflow,
  nodeDetailText,
  spentText,
} from "@cairn/client-logic/WorkflowPanel";
import type {
  NodeStatus,
  PhaseLabel,
  StepsNode,
  WorkflowGroup,
} from "@cairn/client-logic/WorkflowSteps";
import {
  isLiveNodeStatus,
  phaseLabel,
  workflowHeadline,
} from "@cairn/client-logic/WorkflowSteps";
import type { ThreadId } from "@cairn/protocol/Ids";
import type { WorkflowRecord } from "@cairn/protocol/Workflows";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { CornerLeftUp } from "lucide";

import { threadRouter } from "../Route.ts";
import { button, buttonClass, buttonDefaults } from "../ui/Button.ts";
import {
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { disclosure } from "../ui/Disclosure.ts";
import { glyph, stopGlyph } from "../ui/Glyph.ts";
import { modalSheet, sheetDefaults, sideColumn } from "../ui/Sheet.ts";
import type { SheetConfig } from "../ui/Sheet.ts";
import { toneOfThreadTone } from "../ui/Tone.ts";
import type { Message } from "./Message.ts";
import { Message as ShellMessage } from "./Message.ts";
import { stopKeyOf } from "./Model.ts";
import type { WorkState } from "./Model.ts";
import { mark, WORK_PANEL_ID } from "./Work.ts";
import type { WorkViewInputs } from "./Work.ts";

type H = HtmlBuilder<Message>;

// ---------------------------------------------------------------------------------------------
// Pieces

/** A state's mark, from the one state table (U-14). */
const lookMark = (h: H, look: StateLook): Html =>
  mark(h, toneOfThreadTone(look.tone), look.mark);

/** A subagent's steps in the table's words, sentence case like every row's (U-14). */
const STEP_LOOK: Readonly<Record<ChildStepState, StateLook>> = {
  done: STATE_LOOKS.done,
  now: STATE_LOOKS.now,
  todo: STATE_LOOKS.todo,
  failed: STATE_LOOKS.failed,
  stopped: STATE_LOOKS.stopped,
};

const sectionHeading = (
  h: H,
  title: string,
  aside: ReadonlyArray<Html> = []
): Html =>
  h.div(
    [
      h.Class(
        "flex min-h-8 items-center gap-(--space-2) px-(--space-2) pt-(--space-2)"
      ),
    ],
    [
      h.h3(
        [
          h.Class(
            classNames(
              "min-w-0 flex-1 truncate text-ink-3",
              TYPE.small,
              WEIGHT_MEDIUM
            )
          ),
        ],
        [title]
      ),
      ...aside,
    ]
  );

const ROW = classNames(
  "flex min-h-10 w-full min-w-0 items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1) text-start text-ink-1",
  HIT_HEIGHT,
  TYPE.ui
);

const LINK_ROW = classNames(
  ROW,
  "cursor-pointer hover:bg-select-1",
  FOCUS_RING_INSET
);

const word = (h: H, text: string, slot: string): Html =>
  h.span(
    [
      h.DataAttribute("slot", slot),
      h.Class(classNames("shrink-0 whitespace-nowrap text-ink-2", TYPE.small)),
    ],
    [text]
  );

const title = (h: H, text: string): Html =>
  h.span(
    [h.Class(classNames("min-w-0 flex-1 truncate", WEIGHT_MEDIUM))],
    [text]
  );

// ---------------------------------------------------------------------------------------------
// Lineage

const ancestorRow = (h: H, ancestor: LineageAncestor, index: number): Html => {
  const relation = index === 0 ? "Parent" : "Above it";

  return h.li(
    [
      h.DataAttribute("testid", "work-ancestor"),
      h.DataAttribute("thread-id", ancestor.threadId),
    ],
    [
      Option.match(ancestor.thread, {
        onNone: () =>
          h.div(
            [h.Class(classNames(ROW, "text-ink-3"))],
            [
              h.span(
                [h.Class("inline-flex shrink-0 text-ink-3")],
                [glyph(h, CornerLeftUp, "corner-left-up", "regular")]
              ),
              title(h, "A thread no longer here"),
              word(h, relation, "work-relation"),
            ]
          ),
        onSome: (thread) =>
          h.a(
            [h.Href(threadRouter({ threadId: thread.id })), h.Class(LINK_ROW)],
            [
              h.span(
                [h.Class("inline-flex shrink-0 text-ink-3")],
                [glyph(h, CornerLeftUp, "corner-left-up", "regular")]
              ),
              title(h, thread.title),
              word(h, relation, "work-relation"),
            ]
          ),
      }),
    ]
  );
};

/**
 * A row's Stop (U-3): the word and the one Stop glyph, never a bare square. Nothing undoes a stop,
 * so the first press asks "Stop?" in place and the second stops; leaving the control, any other
 * press in the panel, or a pause of `STOP_ASK_MS` lets it go.
 */
const rowStop = (
  h: H,
  config: {
    readonly title: string;
    readonly testId: string;
    readonly isArmed: boolean;
    readonly message: Message;
  }
): Html =>
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: config.isArmed ? "danger" : "ghost",
      size: "small",
      onClick: Option.some(config.message),
      ariaLabel: Option.some(
        config.isArmed
          ? `Stop ${config.title}? Press again to stop it`
          : `Stop ${config.title}`
      ),
      attributes: [
        h.DataAttribute("testid", config.testId),
        ...onlyIf(config.isArmed, h.DataAttribute("armed", "true")),
        h.OnBlur(ShellMessage.BlurredStop()),
      ],
    },
    [stopGlyph(h), config.isArmed ? "Stop?" : "Stop"]
  );

const childRow = (h: H, child: LineageChild, work: WorkState): Html => {
  const { thread, status, label } = child;
  const isStopping = work.stopping.includes(thread.id);
  const isStoppable = isStoppableChildStatus(status);
  const look = isStopping ? STATE_LOOKS.stopping : label;

  return h.li(
    [
      h.DataAttribute("testid", "work-child"),
      h.DataAttribute("thread-id", thread.id),
      h.DataAttribute("state", status),
      ...onlyIf(isStopping, h.DataAttribute("stopping", "true")),
      h.Class("flex min-w-0 items-center gap-(--space-1)"),
    ],
    [
      h.a(
        [
          h.DataAttribute("slot", "work-child-open"),
          h.Href(threadRouter({ threadId: thread.id })),
          h.Class(LINK_ROW),
        ],
        [
          lookMark(h, look),
          title(h, thread.title),
          word(h, look.word, "work-child-state"),
        ]
      ),
      isStoppable && !isStopping
        ? rowStop(h, {
            title: thread.title,
            testId: "work-child-stop",
            isArmed: Option.contains(work.armedStop, thread.id),
            message: ShellMessage.ClickedStopChild({ threadId: thread.id }),
          })
        : h.empty,
    ]
  );
};

const moreButton = (h: H, hidden: number, group: "active" | "previous"): Html =>
  hidden <= 0
    ? h.empty
    : h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "work-children-more"),
          h.DataAttribute("group", group),
          h.OnClick(ShellMessage.ClickedMoreChildren({ group })),
          h.Class(classNames(LINK_ROW, "text-ink-2")),
        ],
        [`Show ${String(showMoreCount(hidden))} more`]
      );

/** The way up: the parent first, each a link to its thread. */
const ancestorsList = (h: H, lineage: Lineage): Html =>
  lineage.ancestors.length === 0
    ? h.empty
    : h.ul(
        [
          h.DataAttribute("testid", "work-ancestors"),
          h.AriaLabel("Parents"),
          h.Class("flex min-w-0 flex-col"),
        ],
        lineage.ancestors.map((ancestor, index) =>
          ancestorRow(h, ancestor, index)
        )
      );

/** The thread's children: the live ones, then "Previous", folded; nothing when it has none. */
const lineageSection = (h: H, lineage: Lineage, work: WorkState): Html => {
  const active = lineageWindow(lineage.active, work.shownActive);
  const previous = lineageWindow(lineage.previous, work.shownPrevious);

  if (lineage.active.length + lineage.previous.length === 0) {
    return h.empty;
  }

  return h.section(
    [
      h.DataAttribute("testid", "work-lineage"),
      h.AriaLabel("Subagents"),
      h.Class("flex min-w-0 flex-col gap-(--space-1)"),
    ],
    [
      sectionHeading(h, "Subagents", [
        word(h, `${String(lineage.active.length)} live`, "work-children-count"),
      ]),
      lineage.active.length === 0
        ? h.empty
        : h.ul(
            [
              h.DataAttribute("testid", "work-children"),
              h.Class("flex min-w-0 flex-col"),
            ],
            active.visibleRows.map((child) => childRow(h, child, work))
          ),
      moreButton(h, active.hiddenCount, "active"),
      lineage.previous.length === 0
        ? h.empty
        : disclosure(
            h,
            {
              id: "work-previous",
              isOpen: work.isPreviousOpen,
              onToggle: () => ShellMessage.ClickedPreviousChildren(),
              isDisabled: false,
              attributes: [h.DataAttribute("testid", "work-previous-toggle")],
            },
            {
              glyph: Option.none(),
              title: `Previous (${String(lineage.previous.length)})`,
              tally: Option.none(),
              body: [
                h.ul(
                  [
                    h.DataAttribute("testid", "work-previous"),
                    h.Class("flex min-w-0 flex-col"),
                  ],
                  previous.visibleRows.map((child) => childRow(h, child, work))
                ),
                moreButton(h, previous.hiddenCount, "previous"),
              ],
            }
          ),
    ]
  );
};

// ---------------------------------------------------------------------------------------------
// Steps

const stepsSection = (h: H, steps: ReadonlyArray<ChildStep>): Html =>
  h.section(
    [
      h.DataAttribute("testid", "work-steps"),
      h.AriaLabel("Steps"),
      h.Class("flex min-w-0 flex-col"),
    ],
    [
      sectionHeading(h, "Steps", [
        word(
          h,
          `${String(doneStepCount(steps))} of ${String(steps.length)}`,
          "work-steps-count"
        ),
      ]),
      h.ol(
        [h.Class("flex min-w-0 flex-col")],
        steps.map((step) => {
          const look = STEP_LOOK[step.state];

          return h.li(
            [
              h.DataAttribute("testid", "work-step"),
              h.DataAttribute("step", step.kind),
              h.DataAttribute("step-state", step.state),
              ...onlyIf(step.state === "now", h.AriaCurrent("step")),
              h.Class(classNames(ROW, "min-h-9 pointer-coarse:min-h-9")),
            ],
            [
              lookMark(h, look),
              title(h, step.title),
              Option.match(step.meta, {
                onNone: () => h.empty,
                onSome: (meta) => word(h, meta, "work-step-meta"),
              }),
              word(h, look.word, "work-step-word"),
            ]
          );
        })
      ),
    ]
  );

// ---------------------------------------------------------------------------------------------
// Workflows

/** A node's state in the table's words: a running node is a working child, "Working" (U-14). */
const NODE_LOOK: Readonly<Record<NodeStatus, StateLook>> = {
  queued: STATE_LOOKS.queued,
  running: STATE_LOOKS.working,
  held: STATE_LOOKS.held,
  unknown: STATE_LOOKS.unknown,
  done: STATE_LOOKS.done,
  failed: STATE_LOOKS.failed,
  stopped: STATE_LOOKS.stopped,
  refused: STATE_LOOKS.refused,
};

/** A phase's state in the table's words; one not started yet is "To do", as a step is. */
const PHASE_LOOK: Readonly<Record<PhaseLabel, StateLook>> = {
  running: STATE_LOOKS.working,
  failed: STATE_LOOKS.failed,
  stopped: STATE_LOOKS.stopped,
  done: STATE_LOOKS.done,
  "not started": STATE_LOOKS.todo,
};

/** Where a workflow is drawn: its thread, and the panel's Stopping keys. */
interface WorkflowPlace {
  readonly threadId: ThreadId;
  readonly work: WorkState;
}

const nodeRow = (
  h: H,
  member: StepsNode,
  workflow: WorkflowRecord,
  place: WorkflowPlace
): Html => {
  const { node } = member;
  const key = stopKeyOf(workflow.id, Option.some(node.id));

  // Stopping the node or its whole workflow: the node's own word waits for the ledger.
  const isStopping =
    isLiveNodeStatus(member.status) &&
    (place.work.stoppingWork.includes(key) ||
      place.work.stoppingWork.includes(workflow.id));

  const look = isStopping ? STATE_LOOKS.stopping : NODE_LOOK[member.status];

  return h.li(
    [
      h.DataAttribute("testid", "work-node"),
      h.DataAttribute("node-id", node.id),
      h.DataAttribute("status", member.status),
      ...onlyIf(isStopping, h.DataAttribute("stopping", "true")),
      h.Class("flex min-w-0 items-center gap-(--space-1) ps-(--space-4)"),
    ],
    [
      h.div(
        [
          h.Class(
            classNames(
              ROW,
              "min-h-9 flex-1 items-start py-(--space-1) pointer-coarse:min-h-9"
            )
          ),
        ],
        [
          h.span([h.Class("mt-0.5 inline-flex shrink-0")], [lookMark(h, look)]),
          h.span(
            [h.Class("flex min-w-0 flex-1 flex-col")],
            [
              title(h, node.label),
              h.span(
                [
                  h.DataAttribute("slot", "work-node-detail"),
                  h.Class(
                    classNames("min-w-0 truncate text-ink-3", TYPE.small)
                  ),
                ],
                [nodeDetailText(member)]
              ),
            ]
          ),
          word(h, look.word, "work-node-status"),
        ]
      ),
      isStoppableNode(member, workflow) && !isStopping
        ? rowStop(h, {
            title: node.label,
            testId: "work-node-stop",
            isArmed: Option.contains(place.work.armedStop, key),
            message: ShellMessage.ClickedStopWorkflow({
              threadId: place.threadId,
              workflowId: workflow.id,
              nodeId: Option.some(node.id),
            }),
          })
        : h.empty,
    ]
  );
};

const workflowBlock = (
  h: H,
  group: WorkflowGroup,
  place: WorkflowPlace
): Html => {
  const headline = workflowHeadline(group);
  const { workflow } = group;
  const isStopping = place.work.stoppingWork.includes(workflow.id);

  return h.div(
    [
      h.DataAttribute("testid", "work-workflow"),
      h.DataAttribute("workflow-id", workflow.id),
      h.DataAttribute("state", workflow.state),
      ...onlyIf(isStopping, h.DataAttribute("stopping", "true")),
      h.Class("flex min-w-0 flex-col"),
    ],
    [
      h.div(
        [
          h.Class(
            "flex min-w-0 items-start gap-(--space-2) px-(--space-2) py-(--space-1)"
          ),
        ],
        [
          h.div(
            [h.Class("flex min-w-0 flex-1 flex-col")],
            [
              h.span(
                [
                  h.Class(
                    classNames(
                      "min-w-0 truncate text-ink-1",
                      TYPE.ui,
                      WEIGHT_STRONG
                    )
                  ),
                ],
                [headline.title]
              ),
              Option.match(headline.nodes, {
                onNone: () => h.empty,
                onSome: (tally) =>
                  h.span(
                    [
                      h.DataAttribute("slot", "work-workflow-tally"),
                      h.Class(
                        classNames("min-w-0 truncate text-ink-2", TYPE.small)
                      ),
                    ],
                    [tally]
                  ),
              }),
              h.span(
                [
                  h.DataAttribute("slot", "work-workflow-spent"),
                  h.Class(
                    classNames(
                      "min-w-0 truncate tabular-nums text-ink-3",
                      TYPE.small
                    )
                  ),
                ],
                [spentText(group)]
              ),
            ]
          ),
          isStoppableWorkflow(workflow)
            ? button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "secondary",
                  size: "small",
                  isBusy: isStopping,
                  isDisabled: isStopping,
                  onClick: Option.some(
                    ShellMessage.ClickedStopWorkflow({
                      threadId: place.threadId,
                      workflowId: workflow.id,
                      nodeId: Option.none(),
                    })
                  ),
                  attributes: [
                    h.DataAttribute("testid", "work-workflow-stop"),
                    h.AriaLabel(`Stop workflow ${workflow.name}`),
                  ],
                },
                [isStopping ? "Stopping" : "Stop workflow"]
              )
            : h.empty,
        ]
      ),
      h.ol(
        [h.Class("flex min-w-0 flex-col")],
        [
          ...group.unphasedNodes.map((member) =>
            nodeRow(h, member, workflow, place)
          ),
          ...group.phases.flatMap((phase) => {
            const label = phaseLabel(phase);
            const look = PHASE_LOOK[label];

            return [
              h.li(
                [
                  h.DataAttribute("testid", "work-phase"),
                  h.DataAttribute("phase-state", phase.state),
                  h.Class(classNames(ROW, "min-h-9 pointer-coarse:min-h-9")),
                ],
                [
                  lookMark(h, look),
                  title(h, phase.title),
                  h.span(
                    [
                      h.Class(
                        classNames(
                          "shrink-0 tabular-nums text-ink-3",
                          TYPE.small
                        )
                      ),
                    ],
                    [
                      `${String(phase.settledCount)}/${String(phase.members.length)}`,
                    ]
                  ),
                  word(h, look.word, "work-phase-label"),
                ]
              ),
              ...phase.members.map((member) =>
                nodeRow(h, member, workflow, place)
              ),
            ];
          }),
        ]
      ),
    ]
  );
};

const workflowsSection = (
  h: H,
  workflows: ReadonlyArray<WorkflowGroup>,
  place: WorkflowPlace
): Html =>
  h.section(
    [
      h.DataAttribute("testid", "work-workflows"),
      h.AriaLabel("Workflows"),
      h.Class("flex min-w-0 flex-col gap-(--space-1)"),
    ],
    [
      sectionHeading(h, "Workflows"),
      ...workflows.map((group) => workflowBlock(h, group, place)),
    ]
  );

const failureLine = (h: H, failure: string): Html =>
  h.div(
    [
      h.DataAttribute("testid", "work-failure"),
      h.Role("alert"),
      h.Class(
        classNames(
          "flex min-w-0 items-start gap-(--space-2) rounded-(--radius-small) border border-stroke-1 px-(--space-2) py-(--space-1-5) text-ink-1",
          TYPE.small
        )
      ),
    ],
    [
      mark(h, "failed"),
      h.span([h.Class("min-w-0 flex-1")], [failure]),
      h.button(
        [
          h.Type("button"),
          h.OnClick(ShellMessage.ClickedDismissWorkFailure()),
          h.Class(buttonClass("ghost", "small")),
        ],
        ["Dismiss"]
      ),
    ]
  );

/**
 * The work panel while it is open, on the sheet: under `lg` a modal sheet (a dialog over a
 * scrim, bottom sheet on the phone), from `lg` a column beside the chat that leaves the page in
 * use. Nothing while closed, or off a thread with something to show.
 */
export const workPanelView = Submodel.defineView<
  WorkState,
  Message,
  WorkViewInputs
>((work, { inputs, isWide }, h) => {
  if (!work.isOpen || Option.isNone(inputs)) {
    return h.empty;
  }

  const shown = inputs.value;

  const config: SheetConfig<Message> = {
    ...sheetDefaults<Message>(WORK_PANEL_ID, "Work"),
    layout: "list",
    closeLabel: "Close the work panel",
    attributes: [h.DataAttribute("testid", "work-panel")],
    scrimAttributes: [h.DataAttribute("testid", "work-scrim")],
    closeAttributes: [h.DataAttribute("testid", "work-close")],
  };

  const body = [
    Option.match(work.failure, {
      onNone: () => h.empty,
      onSome: (failure) => failureLine(h, failure),
    }),
    ancestorsList(h, shown.lineage),
    Option.match(shown.steps, {
      onNone: () => h.empty,
      onSome: (steps) => stepsSection(h, steps),
    }),
    lineageSection(h, shown.lineage, work),
    shown.workflows.length === 0
      ? h.empty
      : workflowsSection(h, shown.workflows, {
          threadId: shown.threadId,
          work,
        }),
  ];

  return isWide
    ? sideColumn(
        h,
        { ...config, onClose: Option.some(ShellMessage.ClickedCloseWork()) },
        body,
        []
      )
    : modalSheet(
        h,
        {
          ...config,
          role: "dialog",
          focusSelector: Option.none(),
          onClose: ShellMessage.ClickedCloseWork(),
          onSettled: ShellMessage.SettledOverlay(),
        },
        body,
        []
      );
});
