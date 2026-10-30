// The work panel (plan wave 6, 6E; surfaces notes S5 and S7): for a thread in a tree, its lineage
// and its steps, beside the transcript at 1,024 px and up and as a bottom sheet below that, opened
// from the chat header's work button.
//
// - Lineage: the way up (the parent, then its parent, each a link) and the thread's children, the
//   live ones first with Stop beside each and the resting ones under "Previous", folded, six rows
//   then twelve more per "Show more" (t3code's lineage panel, `ThreadRelationshipsControl.tsx`).
//   A child's state is the one thread-state function's (client-logic `ThreadLineage.ts`).
// - Steps: on a subagent's own page, its steps from Go to its answer (`SubagentSteps.ts`), which the
//   header's button counts ("2/4 steps").
// - Workflows: each workflow of the thread's dispatch ledger as the steps panel reads it
//   (`WorkflowSteps.ts`): its heading and tally, its phases with their nodes.
//
// The Stone look: colour only on the status marks; every word is ink. The panel is drawn beside the
// chat column, never over it, from `lg`; under `lg` it is a sheet over a scrim, at most 85% of the
// viewport tall, its body scrolling on its own. Nothing in it moves the transcript: on a wide
// screen it is its own column, on a phone it floats.
//
// Its utilities are built by `shell.css` with the rest of the shell, into the `next` chunk.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { pendingSubagentRequests } from "@cairn/client-logic/SubagentRollup";
import type {
  ChildStep,
  ChildStepState,
} from "@cairn/client-logic/SubagentSteps";
import { childStepsOf, doneStepCount } from "@cairn/client-logic/SubagentSteps";
import type {
  Lineage,
  LineageAncestor,
  LineageChild,
} from "@cairn/client-logic/ThreadLineage";
import {
  hasLineage,
  isRestingChildStatus,
  lineageOf,
  lineageWindow,
  settledOutcomesOf,
  showMoreCount,
} from "@cairn/client-logic/ThreadLineage";
import type {
  NodeStatus,
  PhaseLabel,
  StepsNode,
  WorkflowGroup,
} from "@cairn/client-logic/WorkflowSteps";
import {
  phaseLabel,
  workflowGroupsOf,
  workflowHeadline,
} from "@cairn/client-logic/WorkflowSteps";
import { ThreadId } from "@cairn/protocol/Ids";
import type { ShellSnapshot } from "@cairn/protocol/Shell";
import { CHILD_DOCUMENT, SUBAGENTS_DOCUMENT } from "@cairn/protocol/Subagents";
import { WORKFLOWS_DOCUMENT } from "@cairn/protocol/Workflows";
import { Option, Predicate, Schema } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { CornerLeftUp, ListTree, Square, X } from "lucide";

import type { Model } from "../../Model.ts";
import { threadRouter } from "../../Route.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { buttonClass, buttonDefaults } from "../ui/Button.ts";
import {
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { disclosure } from "../ui/Disclosure.ts";
import type { StatusMark } from "../ui/Glyph.ts";
import { glyph, markOfTone, statusGlyph } from "../ui/Glyph.ts";
import { iconButton } from "../ui/IconButton.ts";
import type { Tone } from "../ui/Tone.ts";
import { TONE_TEXT, toneOfThreadTone } from "../ui/Tone.ts";
import type { Message } from "./Message.ts";
import { Message as ShellMessage } from "./Message.ts";
import type { WorkState } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** The panel's id, which the header's button controls. */
export const WORK_PANEL_ID = "work-panel";

// ---------------------------------------------------------------------------------------------
// What the panel reads

/** What the work panel shows for the open thread. */
export interface WorkInputs {
  readonly threadId: ThreadId;
  readonly lineage: Lineage;
  /** The open thread's own steps, when it is a subagent with its row. */
  readonly steps: Option.Option<ReadonlyArray<ChildStep>>;
  readonly workflows: ReadonlyArray<WorkflowGroup>;
}

const ChildReportOf = Schema.Struct({ report: Schema.NullOr(Schema.Json) });

const decodeChildReport = Schema.decodeUnknownOption(ChildReportOf);

/** True when a `cairn.child` document holds the child's `report`. */
const hasReportIn = (document: Schema.Json | undefined): boolean =>
  Option.exists(decodeChildReport(document), ({ report }) => report !== null);

interface Memo {
  readonly shell: ShellSnapshot;
  readonly threadId: string;
  readonly subagents: Schema.Json | undefined;
  readonly workflows: Schema.Json | undefined;
  readonly child: Schema.Json | undefined;
  readonly inputs: Option.Option<WorkInputs>;
}

// One entry: the inputs last derived, kept while the shell and the documents they read are the
// same objects, so a keystroke in the composer derives nothing and the panel's view keeps its
// drawing. Held outside the Model on purpose, as `timeline/Subagents.ts` holds its memo.
const memo = new Map<"last", Memo>();

const NO_DOCS: Readonly<Record<string, Schema.Json>> = {};

const deriveInputs = (
  shell: ShellSnapshot,
  threadId: ThreadId,
  docs: Readonly<Record<string, Schema.Json>>
): Option.Option<WorkInputs> => {
  const lineage = lineageOf(
    threadId,
    shell.threads,
    settledOutcomesOf(docs[SUBAGENTS_DOCUMENT])
  );

  const row = shell.threads.find((thread) => thread.id === threadId);

  const steps =
    row === undefined || Option.isNone(row.lineage)
      ? Option.none()
      : Option.some(
          childStepsOf(row, {
            request: Option.fromUndefinedOr(
              pendingSubagentRequests(shell.threads).get(threadId)
            ),
            hasReport: hasReportIn(docs[CHILD_DOCUMENT]),
          })
        );

  const workflows = workflowGroupsOf(docs[WORKFLOWS_DOCUMENT]);

  return hasLineage(lineage) || workflows.length > 0
    ? Option.some({ threadId, lineage, steps, workflows })
    : Option.none();
};

/**
 * What the panel shows for the routed thread; none off a thread's page, or for a thread with no
 * parent, no child and no workflow. The thread page's documents count only once they are the
 * routed thread's.
 */
export const workInputsOf = (
  model: Pick<Model, "route" | "shell"> & {
    readonly thread: Pick<Model["thread"], "threadId" | "view">;
  }
): Option.Option<WorkInputs> => {
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

  const subagents = docs[SUBAGENTS_DOCUMENT];
  const workflows = docs[WORKFLOWS_DOCUMENT];
  const child = docs[CHILD_DOCUMENT];
  const last = memo.get("last");

  if (
    last?.shell === shell &&
    last.threadId === threadId &&
    last.subagents === subagents &&
    last.workflows === workflows &&
    last.child === child
  ) {
    return last.inputs;
  }

  const inputs = deriveInputs(shell, threadId, docs);

  memo.set("last", { shell, threadId, subagents, workflows, child, inputs });

  return inputs;
};

// ---------------------------------------------------------------------------------------------
// Pieces

/** A status mark in its tone: the only colour the panel draws. */
const mark = (h: H, tone: Tone, which: StatusMark = markOfTone(tone)): Html =>
  h.span(
    [h.Class(classNames("inline-flex shrink-0", TONE_TEXT[tone]))],
    [statusGlyph(h, which, "regular")]
  );

const STEP_LOOK: Readonly<
  Record<
    ChildStepState,
    { readonly tone: Tone; readonly mark: StatusMark; readonly word: string }
  >
> = {
  done: { tone: "done", mark: "done", word: "done" },
  now: { tone: "working", mark: "busy", word: "now" },
  todo: { tone: "neutral", mark: "todo", word: "to do" },
  failed: { tone: "failed", mark: "failed", word: "failed" },
  stopped: { tone: "neutral", mark: "idle", word: "stopped" },
};

/** What the steps sum to: failed if one failed, at work while one is now, done when all are. */
const stepsTone = (steps: ReadonlyArray<ChildStep>): Tone => {
  if (steps.some((step) => step.state === "failed")) {
    return "failed";
  }

  if (steps.some((step) => step.state === "now")) {
    return "working";
  }

  return steps.every((step) => step.state === "done") ? "done" : "neutral";
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

const childRow = (h: H, child: LineageChild, work: WorkState): Html => {
  const { thread, status, label } = child;
  const isStopping = work.stopping.includes(thread.id);
  const tone = toneOfThreadTone(label.tone);
  const isActive = !isRestingChildStatus(status);

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
          isStopping ? mark(h, "working", "busy") : mark(h, tone),
          title(h, thread.title),
          word(h, isStopping ? "Stopping" : label.word, "work-child-state"),
        ]
      ),
      isActive && !isStopping
        ? iconButton(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              size: "small",
              label: `Stop ${thread.title}`,
              onClick: Option.some(
                ShellMessage.ClickedStopChild({ threadId: thread.id })
              ),
              attributes: [h.DataAttribute("testid", "work-child-stop")],
            },
            glyph(h, Square, "square", "small")
          )
        : h.empty,
    ]
  );
};

const moreButton = (
  h: H,
  hidden: number,
  group: "active" | "previous"
): Html =>
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

/** The header button's count: "2/4 steps" for a subagent's own page. */
export const stepsCountText = (steps: ReadonlyArray<ChildStep>): string =>
  `${String(doneStepCount(steps))}/${String(steps.length)} steps`;

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
              mark(h, look.tone, look.mark),
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

const NODE_LOOK: Readonly<
  Record<NodeStatus, { readonly tone: Tone; readonly mark: StatusMark }>
> = {
  queued: { tone: "neutral", mark: "todo" },
  running: { tone: "working", mark: "busy" },
  held: { tone: "waiting", mark: "warning" },
  unknown: { tone: "waiting", mark: "warning" },
  done: { tone: "done", mark: "done" },
  failed: { tone: "failed", mark: "failed" },
  stopped: { tone: "neutral", mark: "idle" },
  refused: { tone: "neutral", mark: "idle" },
};

const PHASE_LOOK: Readonly<
  Record<PhaseLabel, { readonly tone: Tone; readonly mark: StatusMark }>
> = {
  running: { tone: "working", mark: "busy" },
  failed: { tone: "failed", mark: "failed" },
  stopped: { tone: "neutral", mark: "idle" },
  done: { tone: "done", mark: "done" },
  "not started": { tone: "neutral", mark: "todo" },
};

const nodeRow = (h: H, member: StepsNode): Html => {
  const look = NODE_LOOK[member.status];

  return h.li(
    [
      h.DataAttribute("testid", "work-node"),
      h.DataAttribute("status", member.status),
      h.Class(classNames(ROW, "min-h-9 ps-(--space-6) pointer-coarse:min-h-9")),
    ],
    [
      mark(h, look.tone, look.mark),
      title(h, member.node.label),
      word(h, member.status, "work-node-status"),
    ]
  );
};

const workflowBlock = (h: H, group: WorkflowGroup): Html => {
  const headline = workflowHeadline(group);

  return h.div(
    [
      h.DataAttribute("testid", "work-workflow"),
      h.DataAttribute("state", group.workflow.state),
      h.Class("flex min-w-0 flex-col"),
    ],
    [
      h.div(
        [h.Class("flex min-w-0 flex-col px-(--space-2) py-(--space-1)")],
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
        ]
      ),
      h.ol(
        [h.Class("flex min-w-0 flex-col")],
        [
          ...group.unphasedNodes.map((member) => nodeRow(h, member)),
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
                  mark(h, look.tone, look.mark),
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
                  word(h, label, "work-phase-label"),
                ]
              ),
              ...phase.members.map((member) => nodeRow(h, member)),
            ];
          }),
        ]
      ),
    ]
  );
};

const workflowsSection = (
  h: H,
  workflows: ReadonlyArray<WorkflowGroup>
): Html =>
  h.section(
    [
      h.DataAttribute("testid", "work-workflows"),
      h.AriaLabel("Workflows"),
      h.Class("flex min-w-0 flex-col gap-(--space-1)"),
    ],
    [
      sectionHeading(h, "Workflows"),
      ...workflows.map((group) => workflowBlock(h, group)),
    ]
  );

// ---------------------------------------------------------------------------------------------
// The header's button and the panel

/** What the header's button and the panel are drawn from: the routed thread's inputs. */
export interface WorkViewInputs {
  readonly inputs: Option.Option<WorkInputs>;
}

/** The header's button words: a subagent's steps, else its children, else its workflows. */
export const workToggleText = (inputs: WorkInputs): string => {
  if (Option.isSome(inputs.steps)) {
    return stepsCountText(inputs.steps.value);
  }

  const children =
    inputs.lineage.active.length + inputs.lineage.previous.length;

  if (children > 0) {
    return `${String(children)} ${children === 1 ? "subagent" : "subagents"}`;
  }

  const count = inputs.workflows.length;

  return `${String(count)} ${count === 1 ? "workflow" : "workflows"}`;
};

/** The header's tone for the button's mark: the steps' sum, else whether any child is live. */
const toggleTone = (inputs: WorkInputs): Tone =>
  Option.match(inputs.steps, {
    onSome: stepsTone,
    onNone: () => (inputs.lineage.active.length > 0 ? "working" : "neutral"),
  });

/** The chat header's work button, for a thread with something to show; it shows or hides the panel. */
export const workToggleView = Submodel.defineView<
  WorkState,
  Message,
  WorkViewInputs
>((work, { inputs }, h) =>
  Option.match(inputs, {
    onNone: () => h.empty,
    onSome: (shown) => {
      const tone = toggleTone(shown);

      return h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "work-toggle"),
          h.DataAttribute("slot", "button"),
          h.AriaExpanded(work.isOpen),
          h.AriaControls(WORK_PANEL_ID),
          h.AriaLabel(`Work: ${workToggleText(shown)}`),
          h.OnClick(ShellMessage.ClickedWork()),
          h.Class(classNames(buttonClass("secondary", "small"), "shrink-0")),
        ],
        [
          Option.isSome(shown.steps)
            ? mark(h, tone)
            : h.span(
                [h.Class(classNames("inline-flex shrink-0", TONE_TEXT[tone]))],
                [glyph(h, ListTree, "list-tree", "small")]
              ),
          h.span(
            [
              h.DataAttribute("slot", "work-toggle-count"),
              h.Class("tabular-nums"),
            ],
            [workToggleText(shown)]
          ),
        ]
      );
    },
  })
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

// Each placement's classes carry their own breakpoint (`max-lg:` and `lg:`), so neither depends on
// which stylesheet the shared primitives' `fixed` or `border-t` land in.
const PANEL = classNames(
  "flex min-w-0 flex-col overflow-hidden border-stroke-1 text-ink-1",
  "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-(--layer-sheet) max-lg:max-h-[85dvh] max-lg:rounded-t-(--radius-large) max-lg:border-t max-lg:bg-surface-overlay max-lg:pb-[env(safe-area-inset-bottom)] max-lg:shadow-(--elevation-3)",
  "lg:w-[22rem] lg:shrink-0 lg:border-l lg:bg-surface-ground"
);

/**
 * The work panel while it is open: a scrim and a bottom sheet under `lg`, a column beside the chat
 * from `lg`. Nothing while closed, or off a thread with something to show.
 */
export const workPanelView = Submodel.defineView<
  WorkState,
  Message,
  WorkViewInputs
>((work, { inputs }, h) => {
  if (!work.isOpen || Option.isNone(inputs)) {
    return h.empty;
  }

  const shown = inputs.value;

  return h.div(
    [h.DataAttribute("slot", "work"), h.Class("contents")],
    [
      h.div([
        h.DataAttribute("testid", "work-scrim"),
        h.AriaHidden(true),
        h.OnClick(ShellMessage.ClickedCloseWork()),
        h.Class(
          "max-lg:fixed max-lg:inset-0 max-lg:z-(--layer-scrim) max-lg:bg-scrim lg:hidden"
        ),
      ]),
      h.aside(
        [
          h.Id(WORK_PANEL_ID),
          h.DataAttribute("testid", "work-panel"),
          h.AriaLabelledBy(`${WORK_PANEL_ID}-title`),
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
                  h.Id(`${WORK_PANEL_ID}-title`),
                  h.Class(
                    classNames(
                      "min-w-0 flex-1 truncate",
                      TYPE.title,
                      WEIGHT_STRONG
                    )
                  ),
                ],
                ["Work"]
              ),
              iconButton(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost",
                  label: "Close the work panel",
                  onClick: Option.some(ShellMessage.ClickedCloseWork()),
                  attributes: [h.DataAttribute("testid", "work-close")],
                },
                glyph(h, X, "x", "regular")
              ),
            ]
          ),
          h.div(
            [
              h.DataAttribute("slot", "work-body"),
              h.Class(
                "flex min-h-0 flex-1 flex-col gap-(--space-3) overflow-y-auto overscroll-contain p-(--space-2)"
              ),
            ],
            [
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
                : workflowsSection(h, shown.workflows),
            ]
          ),
        ]
      ),
    ]
  );
});
