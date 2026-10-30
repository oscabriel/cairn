// The selected project's sidebar list (the user, 2026-10-29): the project's name and root, its one
// project thread on top (the only thread the user talks to), and under it a running list of the
// threads it manages (subagents, brief children, workflow nodes), newest first, each with its
// status mark from the one thread-state function. No Active, Settled, Pinned or Snoozed groups.
// Every row opens its thread. The project thread's row counts its goal's criteria when it holds one
// ("2/4 met", from the row's tally; plan 6H). The foot holds Usage and Settings, with no meters.

import {
  goalTallyShort,
  goalTallyText,
} from "@cairn/client-logic/GoalProgress";
import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Gauge, Plus, Settings } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING_INSET,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { glyph, statusGlyph } from "../ui/Glyph.ts";
import { TONE_TEXT } from "../ui/Tone.ts";
import type { RowStatus } from "./Derived.ts";
import { Message } from "./Message.ts";

/** A managed thread as its row shows it. */
export interface ManagedRow {
  readonly thread: ThreadShell;
  readonly row: RowStatus;
  /** What it is and its age, or that it asks the user. */
  readonly meta: string;
  readonly isOpen: boolean;
}

/** The project thread as its row shows it. */
export interface ProjectThreadRow {
  readonly thread: ThreadShell;
  readonly row: RowStatus;
  readonly age: string;
  readonly isOpen: boolean;
}

/** What the sidebar list shows for the selected project. */
export interface SidebarContent {
  readonly project: Option.Option<ProjectShell>;
  readonly projectThread: Option.Option<ProjectThreadRow>;
  readonly managed: ReadonlyArray<ManagedRow>;
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

const head = (h: HtmlBuilder<Message>, project: ProjectShell): Html =>
  h.div(
    [
      h.Class(
        "flex h-14 shrink-0 flex-col justify-center border-b border-stroke-1 px-(--space-4)"
      ),
    ],
    [
      h.h2(
        [
          h.DataAttribute("testid", "shell-project-title"),
          h.Class(classNames("truncate text-ink-1", TYPE.body, WEIGHT_STRONG)),
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
  );

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

const managedSection = (
  h: HtmlBuilder<Message>,
  managed: ReadonlyArray<ManagedRow>
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
        [String(managed.length)]
      ),
    ]
  ),
  managed.length === 0
    ? h.p(
        [
          h.DataAttribute("testid", "shell-managed-empty"),
          h.Class(classNames("px-(--space-4) text-ink-3", TYPE.small)),
        ],
        ["Subagents, briefs and workflow nodes it starts show here."]
      )
    : h.ul(
        [
          h.DataAttribute("testid", "shell-managed-list"),
          h.Class("flex flex-col gap-(--space-0-5) px-(--space-1-5)"),
        ],
        managed.map((each) => managedView(h, each))
      ),
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

/** The selected project's list: its head, its project thread, the threads it manages, the foot. */
export const sidebarList = (
  h: HtmlBuilder<Message>,
  content: SidebarContent
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
          head(h, project),
          h.div(
            [h.Class("min-h-0 flex-1 overflow-y-auto pb-(--space-3)")],
            Option.match(content.projectThread, {
              onNone: () => [noProjectThread(h, project.id)],
              onSome: (top) => [
                h.div(
                  [h.Class("px-(--space-1-5) pt-(--space-2)")],
                  [projectThreadView(h, top)]
                ),
                ...managedSection(h, content.managed),
              ],
            })
          ),
        ],
      }),
      foot(h, content.current),
    ]
  );
