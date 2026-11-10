// The selected project's sidebar list (the user, 2026-10-29): the project's name and root, its one
// project thread on top (the only thread the user talks to), and under it the threads it manages
// (subagents, brief children, workflow nodes) in the work panel's shape (U-9): the live ones, those
// that ask the user first, then newest first; the resting and failed ones folded under
// "Resting (n)"; each group six rows, then twelve more per "Show more", so the list never grows
// without limit. Each row has its status mark and, where "subagent" was, its word, from the one
// state table. No Active, Settled, Pinned or Snoozed groups.
// Every row opens its thread. The project thread's row counts its goal's criteria when it holds one
// ("2/4 met", from the row's tally; plan 6H). Under them, "Previous (n)" folds the project's earlier
// project threads, the ones a refresh replaced (ADR 0048), newest first; each opens read only. The
// project's head carries its menu (rename, remove; U-10). The foot holds Usage and Settings, with no
// meters.

import {
  goalTallyShort,
  goalTallyText,
} from "@cairn/client-logic/GoalProgress";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { showMoreCount } from "@cairn/client-logic/ThreadLineage";
import type { LineageWindow } from "@cairn/client-logic/ThreadLineage";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Gauge, Plus, Settings } from "lucide";

import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { disclosure } from "../ui/Disclosure.ts";
import { glyph, statusGlyph } from "../ui/Glyph.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { RowStatus } from "./Derived.ts";
import { manageItem, menuAnchor } from "./Manage.ts";
import { Message } from "./Message.ts";
import { ManageAction, MenuTarget } from "./Model.ts";
import type { ManagedGroup } from "./Model.ts";

/** A managed thread as its row shows it. */
export interface ManagedRow {
  readonly thread: ThreadShell;
  readonly row: RowStatus;
  /** Its status word and its age. */
  readonly meta: string;
  readonly isOpen: boolean;
}

/**
 * The threads the project thread manages, in the work panel's shape (U-9): the live ones (those
 * that ask the user first) in a window, and the resting and failed ones folded behind their count,
 * in a window of their own, so the list never grows without limit on screen.
 */
export interface ManagedContent {
  /** Every thread the project thread manages. */
  readonly count: number;
  readonly live: LineageWindow<ManagedRow>;
  readonly resting: LineageWindow<ManagedRow>;
  readonly restingCount: number;
  readonly isRestingOpen: boolean;
  /**
   * The open thread's row while it rests in the closed fold: drawn under the fold's header, so the
   * list still says where the user is. Each window keeps the open row in it too.
   */
  readonly openResting: Option.Option<ManagedRow>;
}

/** The project thread as its row shows it. */
export interface ProjectThreadRow {
  readonly thread: ThreadShell;
  readonly row: RowStatus;
  readonly age: string;
  readonly isOpen: boolean;
}

/** An earlier project thread as its row in the "Previous" fold shows it. */
export interface PreviousRow {
  readonly thread: ThreadShell;
  /** How long ago a refresh replaced it. */
  readonly age: string;
  readonly isOpen: boolean;
}

/** The "Previous" fold: the project's earlier project threads read so far. */
export interface PreviousContent {
  readonly isOpen: boolean;
  readonly rows: ReadonlyArray<PreviousRow>;
  /** Another page follows the rows shown. */
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly failure: Option.Option<string>;
}

/** What the sidebar list shows for the selected project. */
export interface SidebarContent {
  readonly project: Option.Option<ProjectShell>;
  readonly projectThread: Option.Option<ProjectThreadRow>;
  readonly managed: ManagedContent;
  /** None until the project's earlier project threads are read, and while it has none. */
  readonly previous: Option.Option<PreviousContent>;
  /** The project's menu is open. */
  readonly isProjectMenuOpen: boolean;
  /** The route is the usage page or the settings page: its foot button shows as current. */
  readonly current: "usage" | "settings" | "none";
}

const ROW = classNames(
  "relative flex w-full min-w-0 cursor-pointer gap-(--space-2) rounded-(--radius-small) px-(--space-2) text-start text-ink-2 hover:bg-select-1 aria-[current=page]:bg-select-3 aria-[current=page]:text-ink-1 aria-[current=page]:hover:bg-select-4",
  HIT_HEIGHT,
  FOCUS_RING_INSET,
  FEEDBACK_MOTION
);

/** A status mark with its word for assistive technology; the word is the row's title attribute. */
const mark = (h: HtmlBuilder<Message>, row: RowStatus): Html =>
  h.span(
    [
      h.DataAttribute("testid", "shell-status"),
      h.Title(row.status.word),
      h.Class(classNames("inline-flex shrink-0", TONE_TEXT[row.status.tone])),
    ],
    [
      statusGlyph(h, row.status.mark, "regular"),
      h.span([h.Class("sr-only")], [row.status.word]),
    ]
  );

const projectThreadView = (
  h: HtmlBuilder<Message>,
  top: ProjectThreadRow
): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("testid", "shell-project-thread"),
      h.DataAttribute("thread-item", top.thread.id),
      ...onlyIf(top.isOpen, h.AriaCurrent("page")),
      h.OnClick(Message.ClickedThread({ threadId: top.thread.id })),
      h.Class(
        classNames(ROW, "min-h-10 items-center py-(--space-1-5) text-ink-1")
      ),
    ],
    [
      mark(h, top.row),
      h.span(
        [
          h.Class(
            classNames("min-w-0 flex-1 truncate", TYPE.ui, WEIGHT_MEDIUM)
          ),
        ],
        ["Project thread"]
      ),
      Option.match(top.thread.goal, {
        onNone: () => h.empty,
        onSome: (tally) =>
          h.span(
            [
              h.DataAttribute("testid", "shell-goal-tally"),
              h.DataAttribute("met", String(tally.met)),
              h.DataAttribute("total", String(tally.total)),
              h.Title(`Goal: ${goalTallyText(tally)}`),
              h.Class(
                classNames("shrink-0 tabular-nums text-ink-2", TYPE.small)
              ),
            ],
            [goalTallyShort(tally)]
          ),
      }),
      h.span(
        [h.Class(classNames("shrink-0 tabular-nums text-ink-3", TYPE.small))],
        [top.age]
      ),
    ]
  );

const managedView = (h: HtmlBuilder<Message>, managed: ManagedRow): Html =>
  h.li(
    [
      h.Class(
        "relative ms-(--space-4) before:absolute before:-start-2 before:-top-1.5 before:-bottom-1.5 before:w-px before:bg-stroke-2"
      ),
    ],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "shell-managed-thread"),
          h.DataAttribute("thread-item", managed.thread.id),
          ...onlyIf(managed.isOpen, h.AriaCurrent("page")),
          h.OnClick(Message.ClickedThread({ threadId: managed.thread.id })),
          h.Class(classNames(ROW, "items-start py-(--space-1-5)")),
        ],
        [
          h.span([h.Class("mt-0.5 inline-flex")], [mark(h, managed.row)]),
          h.span(
            [h.Class("grid min-w-0 flex-1")],
            [
              h.span(
                [
                  h.DataAttribute("testid", "shell-row-title"),
                  h.Class(
                    classNames(
                      "min-w-0 truncate",
                      TYPE.ui,
                      Option.isSome(managed.thread.pendingRuntimeRequest)
                        ? WEIGHT_STRONG
                        : WEIGHT_MEDIUM
                    )
                  ),
                ],
                [managed.thread.title]
              ),
              h.span(
                [
                  h.Class(
                    classNames(
                      "min-w-0 truncate tabular-nums text-ink-3",
                      TYPE.small
                    )
                  ),
                ],
                [managed.meta]
              ),
            ]
          ),
        ]
      ),
    ]
  );

const head = (
  h: HtmlBuilder<Message>,
  project: ProjectShell,
  isMenuOpen: boolean
): Html =>
  h.div(
    [
      h.Class(
        "flex h-14 shrink-0 items-center gap-(--space-2) border-b border-stroke-1 ps-(--space-4) pe-(--space-2)"
      ),
    ],
    [
      h.div(
        [h.Class("flex min-w-0 flex-1 flex-col justify-center")],
        [
          h.h2(
            [
              h.DataAttribute("testid", "shell-project-title"),
              h.Class(
                classNames("truncate text-ink-1", TYPE.body, WEIGHT_STRONG)
              ),
            ],
            [project.title]
          ),
          h.span(
            [
              h.Class(
                classNames(
                  "truncate font-(family-name:--font-code) text-ink-3",
                  TYPE.small
                )
              ),
            ],
            [project.workspaceRoot]
          ),
        ]
      ),
      menuAnchor(h, {
        target: MenuTarget.Project({ projectId: project.id }),
        label: `${project.title} project actions`,
        testId: "shell-project-menu",
        isOpen: isMenuOpen,
        items: [
          manageItem(
            h,
            "Rename project",
            ManageAction.RenameProject({ projectId: project.id })
          ),
          manageItem(
            h,
            "Remove project",
            ManageAction.RemoveProject({ projectId: project.id })
          ),
        ],
      }),
    ]
  );

const previousRowView = (h: HtmlBuilder<Message>, row: PreviousRow): Html =>
  h.li(
    [],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "shell-previous-thread"),
          h.DataAttribute("thread-item", row.thread.id),
          ...onlyIf(row.isOpen, h.AriaCurrent("page")),
          h.OnClick(Message.ClickedPreviousThread({ thread: row.thread })),
          h.Class(classNames(ROW, "items-center py-(--space-1-5)")),
        ],
        [
          h.span(
            [
              h.Class(
                classNames("min-w-0 flex-1 truncate", TYPE.ui, WEIGHT_MEDIUM)
              ),
            ],
            [row.thread.title]
          ),
          h.span(
            [
              h.Class(
                classNames("shrink-0 tabular-nums text-ink-3", TYPE.small)
              ),
            ],
            [row.age]
          ),
        ]
      ),
    ]
  );

/** "Previous (n)": the project's earlier project threads, folded; each opens read only. */
const previousSection = (
  h: HtmlBuilder<Message>,
  previous: Option.Option<PreviousContent>,
  idSuffix: string
): Html =>
  Option.match(previous, {
    onNone: () => h.empty,
    onSome: (content) =>
      h.div(
        [
          h.DataAttribute("testid", "shell-previous"),
          h.Class("px-(--space-1-5) pt-(--space-4)"),
        ],
        [
          disclosure(
            h,
            {
              id: `shell-previous${idSuffix}`,
              isOpen: content.isOpen,
              onToggle: () => Message.ClickedPreviousThreads(),
              isDisabled: false,
              attributes: [h.DataAttribute("testid", "shell-previous-toggle")],
            },
            {
              glyph: Option.none(),
              title: `Previous (${String(content.rows.length)}${content.hasMore ? "+" : ""})`,
              tally: Option.none(),
              body: [
                h.ul(
                  [
                    h.DataAttribute("testid", "shell-previous-list"),
                    h.AriaLabel("Earlier project threads"),
                    h.Class("flex flex-col gap-(--space-0-5)"),
                  ],
                  content.rows.map((row) => previousRowView(h, row))
                ),
                content.hasMore
                  ? button(
                      h,
                      {
                        ...buttonDefaults<Message>(),
                        variant: "ghost",
                        size: "small",
                        isBusy: content.isLoading,
                        onClick: Option.some(
                          Message.ClickedMorePreviousThreads()
                        ),
                        attributes: [
                          h.DataAttribute("testid", "shell-previous-more"),
                        ],
                      },
                      ["Show more"]
                    )
                  : h.empty,
                Option.match(content.failure, {
                  onNone: () => h.empty,
                  onSome: (text) =>
                    h.p(
                      [
                        h.Role("status"),
                        h.Class(
                          classNames("px-(--space-2) text-ink-2", TYPE.small)
                        ),
                      ],
                      [text]
                    ),
                }),
              ],
            }
          ),
        ]
      ),
  });

const noProjectThread = (
  h: HtmlBuilder<Message>,
  projectId: ProjectShell["id"]
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "shell-no-project-thread"),
      h.Class("flex flex-col gap-(--space-2) px-(--space-4) py-(--space-4)"),
    ],
    [
      h.p(
        [h.Class(classNames("text-ink-2", TYPE.ui))],
        ["No project thread yet. The first message you send here starts it."]
      ),
      button(
        h,
        {
          ...buttonDefaults<Message>(),
          size: "small",
          onClick: Option.some(
            Message.ClickedStartProjectThread({ projectId })
          ),
        },
        [glyph(h, Plus, "plus", "small"), "Start the project thread"]
      ),
    ]
  );

/** "Show N more" under a managed group, while it hides rows. */
const managedMore = (
  h: HtmlBuilder<Message>,
  hidden: number,
  group: ManagedGroup
): Html =>
  hidden <= 0
    ? h.empty
    : h.div(
        [h.Class("ms-(--space-4) px-(--space-1-5)")],
        [
          button(
            h,
            {
              ...buttonDefaults<Message>(),
              variant: "ghost",
              size: "small",
              onClick: Option.some(Message.ClickedMoreManaged({ group })),
              attributes: [
                h.DataAttribute("testid", "shell-managed-more"),
                h.DataAttribute("group", group),
              ],
            },
            [`Show ${String(showMoreCount(hidden))} more`]
          ),
        ]
      );

const managedList = (
  h: HtmlBuilder<Message>,
  testId: string,
  rows: ReadonlyArray<ManagedRow>
): Html =>
  h.ul(
    [
      h.DataAttribute("testid", testId),
      h.Class("flex flex-col gap-(--space-0-5) px-(--space-1-5)"),
    ],
    rows.map((each) => managedView(h, each))
  );

const managedSection = (
  h: HtmlBuilder<Message>,
  managed: ManagedContent,
  idSuffix: string
): ReadonlyArray<Html> => [
  h.div(
    [
      h.Class(
        classNames(
          "flex items-center justify-between px-(--space-4) pt-(--space-4) pb-(--space-1-5) text-ink-3",
          TYPE.small
        )
      ),
    ],
    [
      h.h3([], ["Threads it manages"]),
      h.span(
        [
          h.DataAttribute("testid", "shell-managed-count"),
          h.Class("tabular-nums"),
        ],
        [String(managed.count)]
      ),
    ]
  ),
  managed.count === 0
    ? h.p(
        [
          h.DataAttribute("testid", "shell-managed-empty"),
          h.Class(classNames("px-(--space-4) text-ink-3", TYPE.small)),
        ],
        ["Subagents, briefs and workflow nodes it starts show here."]
      )
    : h.empty,
  managed.live.visibleRows.length === 0
    ? h.empty
    : managedList(h, "shell-managed-list", managed.live.visibleRows),
  managedMore(h, managed.live.hiddenCount, "live"),
  managed.restingCount === 0
    ? h.empty
    : h.div(
        [
          h.DataAttribute("testid", "shell-resting"),
          h.Class("px-(--space-1-5) pt-(--space-1-5)"),
        ],
        [
          disclosure(
            h,
            {
              id: `shell-resting${idSuffix}`,
              isOpen: managed.isRestingOpen,
              onToggle: () => Message.ClickedRestingThreads(),
              isDisabled: false,
              attributes: [h.DataAttribute("testid", "shell-resting-toggle")],
            },
            {
              glyph: Option.none(),
              title: `Resting (${String(managed.restingCount)})`,
              tally: Option.none(),
              body: [
                managedList(
                  h,
                  "shell-resting-list",
                  managed.resting.visibleRows
                ),
                managedMore(h, managed.resting.hiddenCount, "resting"),
              ],
            }
          ),
        ]
      ),
  Option.match(managed.openResting, {
    onNone: () => h.empty,
    onSome: (open) => managedList(h, "shell-resting-open", [open]),
  }),
];

const footButton = (
  h: HtmlBuilder<Message>,
  testId: string,
  label: string,
  icon: Html,
  message: Message,
  isCurrent: boolean
): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("testid", testId),
      ...onlyIf(isCurrent, h.AriaCurrent("page")),
      h.OnClick(message),
      h.Class(
        classNames(
          "inline-flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center gap-(--space-2) rounded-(--radius-medium) text-ink-2 hover:bg-select-1 hover:text-ink-1 aria-[current=page]:bg-select-3 aria-[current=page]:text-ink-1",
          "pointer-coarse:h-(--hit-target)",
          TYPE.ui,
          WEIGHT_MEDIUM,
          FOCUS_RING_INSET,
          FEEDBACK_MOTION
        )
      ),
    ],
    [icon, h.span([], [label])]
  );

/** The foot: Usage and Settings, with no meters. */
export const foot = (
  h: HtmlBuilder<Message>,
  current: SidebarContent["current"]
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "shell-foot"),
      h.Class(
        "flex shrink-0 gap-(--space-1) border-t border-stroke-1 px-(--space-2) pt-(--space-2) pb-[max(var(--space-3),env(safe-area-inset-bottom))]"
      ),
    ],
    [
      footButton(
        h,
        "shell-usage",
        "Usage",
        glyph(h, Gauge, "gauge", "regular"),
        Message.ClickedUsage(),
        current === "usage"
      ),
      footButton(
        h,
        "shell-settings",
        "Settings",
        glyph(h, Settings, "settings", "regular"),
        Message.ClickedSettings(),
        current === "settings"
      ),
    ]
  );

/**
 * The selected project's list: its head, its project thread, the threads it manages, the earlier
 * ones, the foot. `idSuffix` keeps element ids unique while the phone's sheet draws a second copy.
 */
export const sidebarList = (
  h: HtmlBuilder<Message>,
  content: SidebarContent,
  idSuffix = ""
): Html =>
  h.div(
    [
      h.DataAttribute("testid", "shell-sidebar"),
      h.Class("flex min-h-0 min-w-0 flex-1 flex-col bg-surface-sidebar"),
    ],
    [
      ...Option.match(content.project, {
        onNone: () => [
          h.div(
            [
              h.DataAttribute("testid", "shell-no-projects"),
              h.Class(
                classNames("px-(--space-4) py-(--space-6) text-ink-2", TYPE.ui)
              ),
            ],
            ["Add a project to start. Its project thread will show here."]
          ),
        ],
        onSome: (project) => [
          head(h, project, content.isProjectMenuOpen),
          h.div(
            [h.Class("min-h-0 flex-1 overflow-y-auto pb-(--space-3)")],
            [
              ...Option.match(content.projectThread, {
                onNone: () => [noProjectThread(h, project.id)],
                onSome: (top) => [
                  h.div(
                    [h.Class("px-(--space-1-5) pt-(--space-2)")],
                    [projectThreadView(h, top)]
                  ),
                  ...managedSection(h, content.managed, idSuffix),
                ],
              }),
              previousSection(h, content.previous, idSuffix),
            ]
          ),
        ],
      }),
      foot(h, content.current),
    ]
  );
