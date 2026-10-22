// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.tsx (`SidebarThreadRow` card
// and slim variants, `SidebarSearchResultRow`, `SidebarDraftRow`, `WorkingDuration`,
// `RelativeTimeLabel`), apps/web/src/components/ProjectMonogram.tsx, ThreadSearchMatch.tsx and
// ThreadStatusIndicators.tsx (`ThreadWorktreeIndicator`) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the DOM, class strings, `data-testid`s and the status words of each row state, with the
// receding and unseen rules. Changed: Foldkit views over Cairn's shell rows; a parked row reads
// "Parked" and offers Retry; the provider mark is shown for Claude threads only; the hover card, the
// pull request badge, terminal and drag controls are not ported.
//
// MIT License. Copyright (c) 2026 T3 Tools Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
// NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
// OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
import {
  deriveProjectIdentity,
  hasUnseenCompletion,
  isThreadWoke,
  monogramGlyphCount,
  resolveSidebarRowAccessibility,
  resolveSidebarThreadStatus,
  resolveSidebarTopStatus,
  searchExcerpt,
  shouldRecedeSidebarThread,
  splitHighlights,
} from "@cairn/client-logic/Sidebar";
import type {
  SidebarSection,
  SidebarThreadStatus,
  SidebarTopStatus,
} from "@cairn/client-logic/Sidebar";
import { canSnooze, snoozeWakeLabel } from "@cairn/client-logic/ThreadSettled";
import { resolveSettledThreadTimestamp } from "@cairn/client-logic/ThreadSort";
import {
  formatSidebarAge,
  formatWorkingDurationLabel,
} from "@cairn/client-logic/Time";
import type { ProjectShell, ThreadShell } from "@cairn/protocol/Shell";
import { Array, DateTime, Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import {
  ROW_SURFACE_CLASS,
  SLIM_ACTION_CLASS,
  STATUS_CONTROLS_CLASS,
  STATUS_LABEL_CLASS,
} from "./Classes.ts";
import { claudeMark, icon } from "./Icons.ts";
import type { IconName } from "./Icons.ts";
import { Message } from "./Message.ts";
import type { DraftSummary } from "./Model.ts";

type H = HtmlBuilder<Message>;

/** Joins class parts, dropping the empty ones. */
export const cx = (...parts: ReadonlyArray<string | false>): string =>
  parts
    .filter((part): part is string => part !== false && part !== "")
    .join(" ");

/**
 * A project's monogram tile, as t3code draws a project with no favicon: two letters in the
 * project's colour on a tint of it.
 */
export const projectMark = (
  h: H,
  projectTitle: string,
  className: string
): Html => {
  const identity = deriveProjectIdentity(projectTitle);

  return h.span(
    [h.AriaHidden(true), h.Class(className)],
    [
      h.svg(
        [
          h.Attribute("viewBox", "0 0 16 16"),
          h.Attribute(
            "class",
            `size-full overflow-hidden rounded-[25%] font-mono select-none ${identity.colorClassName}`
          ),
          h.Style({
            "background-color":
              "color-mix(in srgb, currentColor 14%, transparent)",
          }),
        ],
        [
          h.text(
            [
              h.Attribute("x", "8"),
              h.Attribute("y", "10.8"),
              h.Attribute("text-anchor", "middle"),
              h.Attribute("fill", "currentColor"),
              h.Attribute("class", "font-mono"),
              h.Attribute("font-size", "8.25"),
              h.Attribute("font-weight", "700"),
              h.Attribute(
                "textLength",
                monogramGlyphCount(identity.monogram) === 1 ? "6" : "12"
              ),
              h.Attribute("lengthAdjust", "spacingAndGlyphs"),
              h.Attribute("text-rendering", "geometricPrecision"),
            ],
            [identity.monogram]
          ),
        ]
      ),
    ]
  );
};

/** What a row needs beyond its thread. */
export interface RowInputs {
  readonly thread: ThreadShell;
  readonly project: Option.Option<ProjectShell>;
  readonly section: SidebarSection;
  readonly nowMs: number;
  readonly isActive: boolean;
  /** The title being typed, while this row is being renamed. */
  readonly renaming: Option.Option<string>;
}

/** A row's top label: its words, icon and colour. */
interface TopStatusLook {
  readonly label: string;
  readonly icon: Option.Option<IconName>;
  readonly className: string;
}

const TOP_STATUS_LOOKS: Readonly<Record<SidebarTopStatus, TopStatusLook>> = {
  working: {
    label: "Working",
    icon: Option.some("circle-dashed"),
    className: "text-info",
  },
  waiting: {
    label: "Waiting",
    icon: Option.some("circle-dot-dashed"),
    className: "text-muted-foreground",
  },
  approval: {
    label: "Approval",
    icon: Option.some("shield-question"),
    className: "text-warning-foreground",
  },
  input: {
    label: "Input",
    icon: Option.some("message-circle-question"),
    className: "text-indigo-600 dark:text-indigo-300",
  },
  limited: {
    label: "Limited",
    icon: Option.some("circle-alert"),
    className: "text-warning",
  },
  failed: {
    label: "Failed",
    icon: Option.some("circle-alert"),
    className: "text-error",
  },
  parked: {
    label: "Parked",
    icon: Option.some("circle-alert"),
    className: "text-warning",
  },
  woke: {
    label: "Woke",
    icon: Option.some("alarm-clock"),
    className: "text-warning",
  },
  done: {
    label: "Done",
    icon: Option.some("circle-check"),
    className: "text-success",
  },
};

/** The facts every row variant reads off its thread. */
interface RowState {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly isWoke: boolean;
  readonly recede: boolean;
  readonly topStatus: Option.Option<SidebarTopStatus>;
}

const rowState = (inputs: RowInputs): RowState => {
  const { thread } = inputs;
  const now = DateTime.makeUnsafe(inputs.nowMs);
  const status = resolveSidebarThreadStatus(thread);
  const isUnread = hasUnseenCompletion(thread);
  const isWoke = isThreadWoke(thread, now);

  return {
    status,
    isUnread,
    isWoke,
    recede: shouldRecedeSidebarThread({
      status,
      isUnread,
      isWoke,
      isActive: inputs.isActive,
      isSelected: false,
    }),
    topStatus: resolveSidebarTopStatus({ status, isUnread, isWoke }),
  };
};

const ageOf = (thread: ThreadShell, nowMs: number): string =>
  formatSidebarAge(
    Option.getOrElse(thread.latestUserMessageAt, () => thread.updatedAt),
    nowMs
  );

/** How long the row has been working or waiting, when it shows a duration. */
const durationOf = (
  thread: ThreadShell,
  status: SidebarThreadStatus,
  nowMs: number
): Option.Option<string> => {
  let since = Option.none<DateTime.Utc>();

  if (status === "working") {
    since = Option.orElse(
      thread.latestRunStartedAt,
      () => thread.latestRunRequestedAt
    );
  } else if (status === "waiting") {
    since = Option.orElse(
      thread.latestRunCompletedAt,
      () => thread.latestRunRequestedAt
    );
  }

  return Option.map(since, (at) =>
    formatWorkingDurationLabel(nowMs - DateTime.toEpochMillis(at))
  );
};

const surfaceTone = (inputs: RowInputs, state: RowState): string => {
  if (inputs.isActive) {
    return "bg-sidebar-row-active text-sidebar-foreground";
  }

  return state.recede
    ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
    : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover";
};

const surfaceClass = (
  inputs: RowInputs,
  state: RowState,
  unsettle: boolean
): string =>
  cx(
    ROW_SURFACE_CLASS,
    unsettle && "[&:not(:hover):not(:focus-within)_*]:text-secondary-label/70",
    surfaceTone(inputs, state),
    state.recede &&
      state.status === "working" &&
      "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
  );

const stop = {
  propagation: "Stop" as const,
  defaultAction: "Prevent" as const,
};

const rowHandlers = (h: H, thread: ThreadShell) => [
  h.OnClick(Message.ClickedRow({ threadId: thread.id })),
  h.OnDoubleClick(Message.DoubleClickedRow({ threadId: thread.id })),
  h.OnPointerDown((_type, _button, _sx, _sy, _at, clientX, clientY) =>
    Option.some(Message.PressedRow({ x: clientX, y: clientY }))
  ),
  h.OnContextMenu(Message.OpenedRowMenu({ threadId: thread.id })),
  h.OnKeyDownPreventDefault((key) =>
    key === "Enter" || key === " "
      ? Option.some(Message.ClickedRow({ threadId: thread.id }))
      : Option.none()
  ),
];

const cardTitleTone = (state: RowState): string => {
  if (state.recede) {
    return "text-secondary-label";
  }

  if (state.isUnread || state.isWoke || state.status === "input") {
    return "text-foreground";
  }

  return state.status === "failed"
    ? "text-foreground/95"
    : "text-foreground/90";
};

const slimTitleTone = (inputs: RowInputs, state: RowState): string => {
  if (state.recede) {
    return "text-secondary-label/70";
  }

  if (inputs.isActive || state.isWoke || state.status === "input") {
    return "text-foreground";
  }

  return state.isUnread ? "text-muted-foreground" : "text-secondary-label/70";
};

const titleClass = (
  inputs: RowInputs,
  state: RowState,
  variant: "card" | "slim"
): string =>
  cx(
    "min-w-0 flex-1 text-sm transition-opacity motion-reduce:transition-none",
    state.recede ? "font-normal" : "font-medium",
    variant === "card"
      ? cx("truncate", cardTitleTone(state))
      : cx(
          "truncate group-focus-within/sidebar-row:text-foreground group-hover/sidebar-row:text-foreground",
          slimTitleTone(inputs, state)
        )
  );

const titleView = (
  h: H,
  inputs: RowInputs,
  state: RowState,
  variant: "card" | "slim"
): Html =>
  Option.match(inputs.renaming, {
    onNone: () =>
      h.span(
        [h.AriaHidden(true), h.Class(titleClass(inputs, state, variant))],
        [inputs.thread.title]
      ),
    onSome: (title) =>
      h.input([
        h.DataAttribute("testid", "sidebar-rename-input"),
        h.Value(title),
        h.AriaLabel("Thread title"),
        h.OnInput((value) => Message.ChangedRenameTitle({ value })),
        h.OnKeyDownPreventDefault((key) =>
          key === "Enter" || key === "Escape"
            ? Option.some(Message.PressedRenameKey({ key }))
            : Option.none()
        ),
        h.OnBlur(Message.BlurredRename()),
        h.OnClick(Message.IgnoredClick(), { propagation: "Stop" }),
        h.Class(
          "min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
        ),
      ]),
  });

const pinIndicator = (h: H, thread: ThreadShell): Html =>
  Option.isSome(thread.pinnedAt)
    ? h.button(
        [
          h.Type("button"),
          h.AriaLabel("Unpin thread"),
          h.OnClick(Message.ClickedUnpin({ threadId: thread.id }), stop),
          h.Class(
            "group/unpin inline-flex cursor-pointer items-center rounded-sm text-muted-foreground/65 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          ),
        ],
        [
          icon(
            h,
            "pin",
            "size-3 shrink-0 group-hover/unpin:hidden group-focus-visible/unpin:hidden"
          ),
          icon(
            h,
            "pin-off",
            "hidden size-3 shrink-0 group-hover/unpin:block group-focus-visible/unpin:block"
          ),
        ]
      )
    : h.empty;

const topStatusView = (h: H, inputs: RowInputs, state: RowState): Html =>
  Option.match(state.topStatus, {
    onNone: () => h.empty,
    onSome: (status) => {
      const look = TOP_STATUS_LOOKS[status];

      const iconView = Option.match(look.icon, {
        onNone: () => h.empty,
        onSome: (name) => icon(h, name, "size-4 shrink-0"),
      });

      if (status === "woke") {
        return h.button(
          [
            h.Type("button"),
            h.AriaLabel("Dismiss Woke notification"),
            h.OnClick(
              Message.ClickedDismissWoke({ threadId: inputs.thread.id }),
              stop
            ),
            h.Class(
              cx(
                "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                look.className
              )
            ),
          ],
          [iconView, h.span([h.Role("status")], [look.label])]
        );
      }

      return h.span(
        [
          h.Class(
            cx("inline-flex items-center gap-1 font-medium", look.className)
          ),
        ],
        [
          iconView,
          h.span([h.Role("status")], [look.label]),
          Option.match(durationOf(inputs.thread, state.status, inputs.nowMs), {
            onNone: () => h.empty,
            onSome: (duration) =>
              h.span(
                [h.AriaHidden(true)],
                [h.span([h.Class("tabular-nums")], [duration])]
              ),
          }),
        ]
      );
    },
  });

const cardControls = (h: H, inputs: RowInputs): Html => {
  const { thread } = inputs;
  const now = DateTime.makeUnsafe(inputs.nowMs);
  const parkedTask = Array.head(thread.parkedTaskIds);

  return h.span(
    [h.Class(STATUS_CONTROLS_CLASS)],
    [
      Option.match(parkedTask, {
        onNone: () => h.empty,
        onSome: (taskId) =>
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Retry parked task"),
              h.OnClick(
                Message.ClickedRetry({ threadId: thread.id, taskId }),
                stop
              ),
              h.Class(
                "inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              ),
            ],
            [icon(h, "rotate-cw", "size-3.5"), "Retry"]
          ),
      }),
      canSnooze(thread, now)
        ? h.button(
            [
              h.Type("button"),
              h.AriaLabel("Snooze thread"),
              h.OnClick(
                Message.ClickedSnoozeButton({ threadId: thread.id }),
                stop
              ),
              h.Class(
                "inline-flex h-full cursor-pointer items-center gap-0.5 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              ),
            ],
            [icon(h, "clock", "size-3")]
          )
        : h.empty,
      h.button(
        [
          h.Type("button"),
          h.AriaLabel("Settle thread"),
          h.OnClick(Message.ClickedSettle({ threadId: thread.id }), stop),
          h.Class(
            "-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
          ),
        ],
        [icon(h, "check", "size-3.5"), "Settle"]
      ),
    ]
  );
};

const isClaude = (thread: ThreadShell): boolean =>
  thread.provider === "claude-bridge" || thread.provider === "anthropic";

const branchLine = (h: H, thread: ThreadShell): Html =>
  h.div(
    [
      h.Class(
        "mt-0.5 flex min-w-0 items-center gap-1.5 text-secondary-label text-xs"
      ),
    ],
    [
      ...Option.match(thread.branch, {
        onNone: () => [h.span([h.Class("flex-1")])],
        onSome: (branch) => [
          Option.isSome(thread.worktreePath)
            ? h.span(
                [
                  h.Role("img"),
                  h.AriaLabel(
                    `Worktree: ${Option.getOrElse(thread.worktreePath, () => "")}`
                  ),
                  h.Class("inline-flex items-center justify-center"),
                ],
                [icon(h, "folder-git-2", "size-3 text-muted-foreground/40")]
              )
            : h.empty,
          h.span(
            [h.Class("flex min-w-0 flex-1 text-muted-foreground/40")],
            [
              h.span(
                [
                  h.Class(
                    "inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap"
                  ),
                ],
                [h.span([h.Class("min-w-0 truncate")], [branch])]
              ),
            ]
          ),
        ],
      }),
      h.span(
        [
          h.AriaHidden(true),
          h.Class(
            "pointer-events-none ml-auto inline-flex shrink-0 items-center gap-1"
          ),
        ],
        isClaude(thread)
          ? [
              h.span(
                [h.Class("inline-flex shrink-0 items-center")],
                [
                  h.span(
                    [
                      h.Class(
                        "relative isolate z-30 inline-flex shrink-0 items-center justify-center overflow-visible"
                      ),
                    ],
                    [claudeMark(h)]
                  ),
                ]
              ),
            ]
          : []
      ),
    ]
  );

const accessibleLabel = (inputs: RowInputs, state: RowState): string =>
  resolveSidebarRowAccessibility({
    title: inputs.thread.title,
    statusLabel: Option.map(
      state.topStatus,
      (status) => TOP_STATUS_LOOKS[status].label
    ),
    projectDisplayName: Option.map(inputs.project, (project) => project.title),
    isActive: inputs.isActive,
  }).label;

const currentPage = (h: H, isActive: boolean) =>
  isActive ? [h.AriaCurrent("page")] : [];

/** A card row: the pinned and active shelves. */
export const cardRow = (h: H, inputs: RowInputs): Html => {
  const { thread } = inputs;
  const state = rowState(inputs);

  return h.li(
    [
      h.Key(thread.id),
      h.DataAttribute("thread-item", thread.id),
      h.Class(
        "list-none py-0.5 [content-visibility:auto] [contain-intrinsic-size:auto_78px]"
      ),
    ],
    [
      h.div(
        [
          h.Role("button"),
          h.Tabindex(0),
          h.AriaLabel(accessibleLabel(inputs, state)),
          ...currentPage(h, inputs.isActive),
          h.DataAttribute("testid", "sidebar-row-card"),
          h.DataAttribute("thread-id", thread.id),
          h.Class(surfaceClass(inputs, state, false)),
          ...rowHandlers(h, thread),
        ],
        [
          h.span([h.Class("sr-only")], [thread.title]),
          h.div(
            [
              h.Class(
                "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)"
              ),
            ],
            [
              h.div(
                [h.Class("flex h-5 min-w-0 items-center gap-1.5")],
                [
                  Option.match(inputs.project, {
                    onNone: () => h.empty,
                    onSome: (project) =>
                      projectMark(
                        h,
                        project.title,
                        "inline-flex items-center justify-center size-4 shrink-0"
                      ),
                  }),
                  pinIndicator(h, thread),
                  Option.match(inputs.project, {
                    onNone: () => h.span([h.Class("flex-1")]),
                    onSome: (project) =>
                      h.span(
                        [
                          h.Class(
                            cx(
                              "min-w-0 flex-1 truncate text-secondary-label text-xs",
                              state.recede ? "font-normal" : "font-medium"
                            )
                          ),
                        ],
                        [project.title]
                      ),
                  }),
                  h.span(
                    [
                      h.Class(
                        "group/sidebar-status-slot relative ml-auto flex h-5 min-w-8 shrink-0 items-stretch justify-end text-xs"
                      ),
                    ],
                    [
                      h.span(
                        [
                          h.Class(
                            Option.contains(state.topStatus, "woke")
                              ? "pointer-events-auto flex items-center self-center justify-self-end tabular-nums text-secondary-label transition-opacity"
                              : STATUS_LABEL_CLASS
                          ),
                        ],
                        [
                          Option.isSome(state.topStatus)
                            ? topStatusView(h, inputs, state)
                            : ageOf(thread, inputs.nowMs),
                        ]
                      ),
                      cardControls(h, inputs),
                    ]
                  ),
                ]
              ),
              h.div(
                [h.Class("mt-1 flex min-w-0")],
                [titleView(h, inputs, state, "card")]
              ),
              branchLine(h, thread),
            ]
          ),
        ]
      ),
    ]
  );
};

/** A slim row: the snoozed and settled shelves. */
export const slimRow = (h: H, inputs: RowInputs): Html => {
  const { thread } = inputs;
  const state = rowState(inputs);
  const isSnoozed = inputs.section === "snoozed";
  const now = DateTime.makeUnsafe(inputs.nowMs);

  const restingLabel = (): Html => {
    if (isSnoozed) {
      return Option.match(thread.snoozedUntil, {
        onNone: () => h.empty,
        onSome: (until) =>
          h.span(
            [h.Class("text-xs text-info-foreground tabular-nums")],
            [snoozeWakeLabel(until, now)]
          ),
      });
    }

    if (state.isWoke) {
      return h.button(
        [
          h.Type("button"),
          h.AriaLabel("Dismiss Woke notification"),
          h.OnClick(Message.ClickedDismissWoke({ threadId: thread.id }), stop),
          h.Class(
            "inline-flex cursor-pointer items-center gap-1 rounded-sm text-xs font-medium text-warning-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          ),
        ],
        [icon(h, "alarm-clock", "size-3"), h.span([h.Role("status")], ["Woke"])]
      );
    }

    return h.span(
      [h.Class("text-xs")],
      [
        formatSidebarAge(
          inputs.section === "settled"
            ? resolveSettledThreadTimestamp(thread)
            : Option.getOrElse(
                thread.latestUserMessageAt,
                () => thread.updatedAt
              ),
          inputs.nowMs
        ),
      ]
    );
  };

  return h.li(
    [
      h.Key(thread.id),
      h.DataAttribute("thread-item", thread.id),
      h.Class(
        "list-none [content-visibility:auto] [contain-intrinsic-size:auto_36px]"
      ),
    ],
    [
      h.div(
        [
          h.Role("button"),
          h.Tabindex(0),
          h.AriaLabel(accessibleLabel(inputs, state)),
          ...currentPage(h, inputs.isActive),
          h.DataAttribute("testid", "sidebar-row-slim"),
          h.DataAttribute("thread-id", thread.id),
          h.Class(
            cx(
              surfaceClass(inputs, state, inputs.section === "settled"),
              "flex h-9 items-center gap-2.5 px-2.5"
            )
          ),
          ...rowHandlers(h, thread),
        ],
        [
          h.span([h.Class("sr-only")], [thread.title]),
          h.span(
            [
              h.Class(
                cx(
                  "flex shrink-0 items-center transition-opacity",
                  (!inputs.isActive || inputs.section === "settled") &&
                    "opacity-40 grayscale group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0 group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0"
                )
              ),
            ],
            [
              Option.match(inputs.project, {
                onNone: () => h.empty,
                onSome: (project) =>
                  projectMark(
                    h,
                    project.title,
                    "inline-flex shrink-0 items-center justify-center size-4"
                  ),
              }),
            ]
          ),
          titleView(h, inputs, state, "slim"),
          pinIndicator(h, thread),
          h.span(
            [
              h.Class(
                "relative ml-auto flex h-6 min-w-8 shrink-0 items-center justify-end"
              ),
            ],
            [
              h.span(
                [
                  h.Class(
                    cx(
                      "inline-flex justify-end tabular-nums text-secondary-label transition-opacity",
                      !state.isWoke && "group-any-hover/sidebar-row:opacity-0"
                    )
                  ),
                ],
                [restingLabel()]
              ),
              isSnoozed
                ? h.button(
                    [
                      h.Type("button"),
                      h.AriaLabel("Wake thread now"),
                      h.OnClick(
                        Message.ClickedUnsnooze({ threadId: thread.id }),
                        stop
                      ),
                      h.Class(
                        cx(
                          SLIM_ACTION_CLASS,
                          state.isWoke && "group-any-hover/sidebar-row:static"
                        )
                      ),
                    ],
                    [icon(h, "alarm-clock-off", "mb-px size-3")]
                  )
                : h.button(
                    [
                      h.Type("button"),
                      h.AriaLabel("Un-settle thread"),
                      h.OnClick(
                        Message.ClickedUnsettle({ threadId: thread.id }),
                        stop
                      ),
                      h.Class(
                        cx(
                          SLIM_ACTION_CLASS,
                          state.isWoke && "group-any-hover/sidebar-row:static"
                        )
                      ),
                    ],
                    [icon(h, "undo-2", "mb-px size-3.5")]
                  ),
            ]
          ),
        ]
      ),
    ]
  );
};

/** One search result. */
export const searchResultRow = (
  h: H,
  inputs: {
    readonly thread: ThreadShell;
    readonly project: Option.Option<ProjectShell>;
    readonly index: number;
    readonly isHighlighted: boolean;
    readonly isActive: boolean;
    readonly isSettled: boolean;
    readonly query: string;
    readonly nowMs: number;
  }
): Html => {
  const { thread } = inputs;
  const lit = inputs.isHighlighted || inputs.isActive;

  const excerpt = Option.flatMap(thread.latestVisibleMessage, (message) =>
    Option.map(searchExcerpt(message.text, inputs.query), (text) => ({
      text,
      isUser: message.role === "user",
    }))
  );

  const resultId = `sidebar-thread-search-result-${inputs.index}`;

  return h.li(
    [h.Key(thread.id), h.Role("presentation"), h.Class("list-none")],
    [
      h.button(
        [
          h.Id(resultId),
          h.DataAttribute("search-result-key", thread.id),
          h.Type("button"),
          h.Role("option"),
          h.Tabindex(-1),
          h.AriaSelected(inputs.isHighlighted),
          ...currentPage(h, inputs.isActive),
          h.AriaDescribedBy(`${resultId}-pr`),
          h.AriaLabel(
            [
              thread.title,
              ...Option.toArray(
                Option.map(inputs.project, (project) => project.title)
              ),
            ].join(", ")
          ),
          h.OnMouseMove(Message.HoveredSearchResult({ index: inputs.index })),
          h.OnClick(Message.ChoseSearchResult({ threadId: thread.id })),
          h.Class(
            cx(
              "group/sidebar-row group/v2-row flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
              lit
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            )
          ),
        ],
        [
          Option.match(inputs.project, {
            onNone: () => h.empty,
            onSome: (project) =>
              projectMark(
                h,
                project.title,
                cx(
                  "inline-flex items-center justify-center size-4 shrink-0 transition-opacity",
                  inputs.isSettled &&
                    !lit &&
                    "opacity-40 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0"
                )
              ),
          }),
          h.span(
            [h.Class("flex min-w-0 flex-1 flex-col")],
            [
              h.span(
                [h.Class("flex min-w-0 items-center gap-2.5")],
                [
                  h.span(
                    [
                      h.Class(
                        cx(
                          "min-w-0 flex-1 truncate",
                          inputs.isSettled
                            ? "font-normal text-secondary-label/70 group-hover/sidebar-row:text-foreground"
                            : "font-medium text-foreground",
                          lit && "text-foreground"
                        )
                      ),
                    ],
                    [thread.title]
                  ),
                  h.span([h.Id(`${resultId}-pr`), h.Class("contents")]),
                  h.span(
                    [
                      h.Class(
                        "w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums"
                      ),
                    ],
                    [ageOf(thread, inputs.nowMs)]
                  ),
                ]
              ),
              Option.match(excerpt, {
                onNone: () => h.empty,
                onSome: ({ isUser, text }) =>
                  h.span(
                    [h.Class("truncate text-xs text-muted-foreground/85")],
                    [
                      h.span(
                        [
                          h.Class(
                            isUser
                              ? "text-info-foreground"
                              : "text-success-foreground"
                          ),
                        ],
                        [isUser ? "You:" : "Agent:"]
                      ),
                      " ",
                      ...splitHighlights(text, inputs.query).map((part) =>
                        part.highlighted
                          ? h.mark(
                              [
                                h.Class(
                                  "bg-transparent font-semibold text-foreground"
                                ),
                              ],
                              [part.text]
                            )
                          : part.text
                      ),
                    ]
                  ),
              }),
            ]
          ),
        ]
      ),
    ]
  );
};

/** An unsent draft's row, above the threads. */
export const draftRow = (
  h: H,
  draft: DraftSummary,
  project: Option.Option<ProjectShell>,
  isActive: boolean
): Html =>
  h.li(
    [h.Key(`draft-${draft.draftId}`), h.Class("list-none py-0.5")],
    [
      h.div(
        [
          h.Role("button"),
          h.Tabindex(0),
          h.AriaLabel(
            [
              draft.preview,
              "Unsent draft",
              ...Option.toArray(Option.map(project, (shell) => shell.title)),
            ].join(", ")
          ),
          ...currentPage(h, isActive),
          h.DataAttribute("testid", "sidebar-draft-row"),
          h.Class(
            cx(
              "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left text-sidebar-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              isActive
                ? "bg-sidebar-row-active"
                : "bg-warning/4 hover:bg-warning/8"
            )
          ),
          h.OnClick(Message.ClickedDraft({ draftId: draft.draftId })),
          h.OnPointerDown((_type, _button, _sx, _sy, _at, clientX, clientY) =>
            Option.some(Message.PressedRow({ x: clientX, y: clientY }))
          ),
          h.OnContextMenu(Message.OpenedDraftMenu({ draftId: draft.draftId })),
        ],
        [
          h.span([h.Class("sr-only")], [draft.preview]),
          h.div(
            [
              h.Class(
                "relative z-10 h-[4.875rem] px-(--sidebar-row-content-inset) py-(--sidebar-content-inset)"
              ),
            ],
            [
              h.div(
                [h.Class("flex h-5 min-w-0 items-center gap-1.5")],
                [
                  icon(
                    h,
                    "square-pen",
                    "size-3 shrink-0 text-warning-foreground"
                  ),
                  Option.match(project, {
                    onNone: () => h.empty,
                    onSome: (shell) =>
                      projectMark(
                        h,
                        shell.title,
                        "inline-flex items-center justify-center size-4 shrink-0"
                      ),
                  }),
                  h.span(
                    [
                      h.Class(
                        "min-w-0 flex-1 truncate text-xs font-medium text-secondary-label"
                      ),
                    ],
                    [
                      Option.getOrElse(
                        Option.map(project, (shell) => shell.title),
                        () => ""
                      ),
                    ]
                  ),
                  h.span(
                    [
                      h.Class(
                        "ml-auto flex h-5 min-w-5 shrink-0 items-center justify-end"
                      ),
                    ],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.AriaLabel("Discard draft"),
                          h.OnClick(
                            Message.ClickedDiscardDraft({
                              draftId: draft.draftId,
                            }),
                            stop
                          ),
                          h.Class(
                            "pointer-events-none inline-flex cursor-pointer items-center rounded-md bg-transparent px-1 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/sidebar-row:pointer-events-auto group-hover/sidebar-row:opacity-100"
                          ),
                        ],
                        [icon(h, "x", "size-3")]
                      ),
                    ]
                  ),
                ]
              ),
              h.div(
                [
                  h.AriaHidden(true),
                  h.Class(
                    "mt-0.5 truncate text-sm font-medium text-foreground/90"
                  ),
                ],
                [draft.preview]
              ),
            ]
          ),
        ]
      ),
    ]
  );
