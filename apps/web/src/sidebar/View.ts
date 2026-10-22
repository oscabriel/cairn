// Ported from github.com/pingdotgg/t3code, apps/web/src/components/Sidebar.tsx (the list of shelves,
// markers, headers and "Show more"; the search results list; the empty state),
// apps/web/src/components/ui/sidebar.tsx (desktop container and phone sheet),
// apps/web/src/components/sidebar/SidebarChrome.tsx (header band and footer) and
// apps/web/src/components/sidebar/SidebarThreadUndoNotice.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the DOM and class strings of each part, the shelf
// order (drafts, pinned, active, snoozed, settled) with their `data-testid`s, labels and counts.
// Changed: the brand band shows the text "Cairn" (no wordmark or starfield, plan D24); the footer
// has Settings, Usage and the connection state instead of pull requests and the update pill; an
// index of every project and thread the judges read is kept, hidden from view and from readers.
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
  SETTLED_TAIL_PAGE_COUNT,
  visibleSettledCount,
} from "@cairn/client-logic/Sidebar";
import type { SidebarSection } from "@cairn/client-logic/Sidebar";
import { buildDraftActionMenuItems } from "@cairn/client-logic/ThreadMenu";
import type { ThreadShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { inboxRouter, settingsRouter } from "../Route.ts";
import { addProjectView } from "./AddProject.ts";
import {
  CHROME_HEADER_CLASS,
  CONTENT_CLASS,
  FOOTER_ICON_BUTTON_CLASS,
  GROUP_CLASS,
  INLINE_BUTTON_CLASS,
  MARKER_CLASS,
  PLACEHOLDER_CLASS,
  SCROLL_ROOT_CLASS,
  SCROLL_VIEWPORT_CLASS,
  SHEET_BACKDROP_CLASS,
  SHEET_COLUMN_CLASS,
  SHEET_POPUP_CLASS,
  SHEET_VIEWPORT_CLASS,
  SHELF_TOGGLE_CLASS,
  SHELF_TONES,
  SHOW_MORE_CLASS,
  SIDEBAR_CONTAINER_CLASS,
  SIDEBAR_GAP_CLASS,
  SIDEBAR_INNER_CLASS,
  SIDEBAR_ROOT_CLASS,
  UNDO_ALERT_CLASS,
} from "./Classes.ts";
import { contextMenuView } from "./ContextMenu.ts";
import {
  findProject,
  findThread,
  isSearching,
  partitionOf,
  projectsOf,
  searchResultsOf,
  threadMenuOf,
} from "./Derived.ts";
import { headerView } from "./Header.ts";
import { icon } from "./Icons.ts";
import { Message } from "./Message.ts";
import type { Shelf } from "./Message.ts";
import { MenuTarget } from "./Model.ts";
import type { Model } from "./Model.ts";
import { ListMotion } from "./Motion.ts";
import { cardRow, cx, draftRow, searchResultRow, slimRow } from "./Row.ts";
import { ScrollFade } from "./ScrollFade.ts";

type H = HtmlBuilder<Message>;

/** The sidebar's width on a desktop. */
export const SIDEBAR_WIDTH = "256px";

const marker = (h: H, name: string, className: string): Html =>
  h.li(
    [
      h.Key(name),
      h.DataAttribute("thread-selection-safe", "true"),
      h.DataAttribute("testid", `sidebar-${name}`),
      h.Class(className),
    ],
    []
  );

const shelfHeader = (
  h: H,
  inputs: {
    readonly shelf: Shelf;
    readonly label: string;
    readonly expanded: boolean;
    readonly pushDown: boolean;
  }
): Html => {
  const tone =
    inputs.shelf === "snoozed" ? SHELF_TONES.info : SHELF_TONES.muted;

  return h.li(
    [
      h.Key(`${inputs.shelf}-header`),
      h.DataAttribute("thread-selection-safe", "true"),
      h.DataAttribute("testid", `sidebar-${inputs.shelf}-header`),
      h.Class(cx("list-none mx-0.5 h-8", inputs.pushDown && "mt-auto")),
    ],
    [
      h.button(
        [
          h.DataAttribute("testid", `sidebar-${inputs.shelf}-shelf-toggle`),
          h.Type("button"),
          h.AriaExpanded(inputs.expanded),
          h.OnClick(Message.ToggledShelf({ shelf: inputs.shelf })),
          h.Class(cx(SHELF_TOGGLE_CLASS, tone.label)),
        ],
        [
          h.span([h.Class("shrink-0")], [inputs.label]),
          h.span(
            [h.AriaHidden(true), h.Class(cx("h-px min-w-2 flex-1", tone.line))],
            []
          ),
          icon(
            h,
            "chevron-down",
            cx(
              "size-3 shrink-0 transition-transform",
              !inputs.expanded && "rotate-180"
            )
          ),
        ]
      ),
    ]
  );
};

const row = (
  h: H,
  model: Model,
  thread: ThreadShell,
  section: SidebarSection
): Html => {
  const inputs = {
    thread,
    project: findProject(model, thread.projectId),
    section,
    nowMs: model.nowMs,
    isActive: Option.contains(model.context.openThreadId, thread.id),
    renaming: Option.flatMap(model.renaming, (renaming) =>
      renaming.threadId === thread.id
        ? Option.some(renaming.title)
        : Option.none()
    ),
  };

  return section === "pinned" || section === "active"
    ? cardRow(h, inputs)
    : slimRow(h, inputs);
};

const draftRows = (h: H, model: Model): ReadonlyArray<Html> => {
  const drafts = model.context.drafts.filter((draft) =>
    Option.match(model.projectFilter, {
      onNone: () => true,
      onSome: (projectId) => Option.contains(draft.projectId, projectId),
    })
  );

  if (drafts.length === 0) {
    return [];
  }

  return [
    ...drafts.map((draft) =>
      draftRow(
        h,
        draft,
        Option.flatMap(draft.projectId, (projectId) =>
          findProject(model, projectId)
        ),
        Option.contains(model.context.openDraftId, draft.draftId)
      )
    ),
    h.li(
      [
        h.Key("draft-divider"),
        h.AriaHidden(true),
        h.DataAttribute("testid", "sidebar-draft-divider"),
        h.Class("mx-2.5 my-1.5 h-px list-none bg-sidebar-border/60"),
      ],
      []
    ),
  ];
};

const emptyState = (h: H, model: Model): Html =>
  h.div(
    [
      h.DataAttribute("testid", "sidebar-empty"),
      h.Class(
        "flex flex-col items-center gap-2 px-2 py-6 text-center text-xs text-muted-foreground/60"
      ),
    ],
    projectsOf(model).length === 0
      ? [
          h.span([], ["No projects yet"]),
          h.button(
            [
              h.Type("button"),
              h.OnClick(Message.ClickedAddProject()),
              h.Class(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-sidebar-border px-2.5 py-1 text-2xs font-medium text-sidebar-muted-foreground transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
              ),
            ],
            [icon(h, "plus", "-mx-0.5 size-3"), "Add project"]
          ),
        ]
      : [
          Option.match(
            Option.flatMap(model.projectFilter, (projectId) =>
              findProject(model, projectId)
            ),
            {
              onNone: () => "No threads yet",
              onSome: (project) => `No threads in ${project.title} yet`,
            }
          ),
        ]
  );

const threadList = (h: H, model: Model): Html => {
  const partition = partitionOf(model);

  const total =
    partition.pinned.length +
    partition.active.length +
    partition.snoozed.length +
    partition.settled.length;

  const drafts = draftRows(h, model);

  if (total === 0 && drafts.length === 0) {
    return emptyState(h, model);
  }

  const shownSettled = model.shelves.settledExpanded
    ? partition.settled.slice(
        0,
        visibleSettledCount(
          partition.settled.length,
          model.shelves.settledPages
        )
      )
    : [];

  const hiddenSettled = partition.settled.length - shownSettled.length;

  return h.ul(
    [
      h.Role("presentation"),
      h.DataAttribute("testid", "sidebar-thread-list"),
      h.Class(cx("relative flex flex-col gap-px", total > 0 && "flex-1")),
      h.OnMount(ListMotion()),
    ],
    [
      ...drafts,
      ...(total === 0
        ? []
        : [
            marker(h, "pinned-header", MARKER_CLASS),
            ...partition.pinned.map((thread) =>
              row(h, model, thread, "pinned")
            ),
            marker(h, "pinned-divider", MARKER_CLASS),
            marker(h, "active-placeholder", PLACEHOLDER_CLASS),
            ...partition.active.map((thread) =>
              row(h, model, thread, "active")
            ),
            ...(partition.snoozed.length > 0
              ? [
                  shelfHeader(h, {
                    shelf: "snoozed",
                    label: model.shelves.snoozedExpanded
                      ? "Snoozed"
                      : `Snoozed (${partition.snoozed.length})`,
                    expanded: model.shelves.snoozedExpanded,
                    pushDown: true,
                  }),
                  ...(model.shelves.snoozedExpanded
                    ? partition.snoozed.map((thread) =>
                        row(h, model, thread, "snoozed")
                      )
                    : []),
                ]
              : []),
            shelfHeader(h, {
              shelf: "settled",
              label: model.shelves.settledExpanded
                ? "Settled"
                : `Settled (${partition.settled.length})`,
              expanded: model.shelves.settledExpanded,
              pushDown: partition.snoozed.length === 0,
            }),
            marker(h, "settled-placeholder", PLACEHOLDER_CLASS),
            ...shownSettled.map((thread) => row(h, model, thread, "settled")),
            ...(model.shelves.settledExpanded && hiddenSettled > 0
              ? [
                  h.li(
                    [h.Key("show-more"), h.Class("list-none")],
                    [
                      h.button(
                        [
                          h.Type("button"),
                          h.DataAttribute(
                            "testid",
                            "sidebar-settled-show-more"
                          ),
                          h.OnClick(Message.ClickedShowMoreSettled()),
                          h.Class(SHOW_MORE_CLASS),
                        ],
                        [
                          icon(h, "plus", "size-4 shrink-0"),
                          `Show ${Math.min(hiddenSettled, SETTLED_TAIL_PAGE_COUNT)} more`,
                        ]
                      ),
                    ]
                  ),
                ]
              : []),
          ]),
    ]
  );
};

const searchResults = (h: H, model: Model): Html => {
  const results = searchResultsOf(model);
  const partition = partitionOf(model);
  const settled = new Set(partition.settled.map((thread) => thread.id));

  if (results.length === 0) {
    return h.p(
      [
        h.Role("status"),
        h.Class("px-2 py-6 text-center text-xs text-sidebar-muted-foreground"),
      ],
      ["No threads found"]
    );
  }

  return h.ul(
    [
      h.Id("sidebar-thread-search-results"),
      h.Role("listbox"),
      h.AriaLabel("Thread search results"),
      h.Class("flex flex-col gap-px"),
    ],
    results.map((thread, index) =>
      searchResultRow(h, {
        thread,
        project: findProject(model, thread.projectId),
        index,
        isHighlighted: index === model.activeSearchIndex,
        isActive: Option.contains(model.context.openThreadId, thread.id),
        isSettled: settled.has(thread.id),
        query: model.search,
        nowMs: model.nowMs,
      })
    )
  );
};

const undoNotice = (h: H, model: Model): Html =>
  Option.match(model.undo, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [h.Class("px-[var(--sidebar-content-inset)] pb-1")],
        [
          h.div(
            [
              h.Role("status"),
              h.DataAttribute("slot", "alert"),
              h.DataAttribute("variant", "sidebar"),
              h.DataAttribute("testid", "sidebar-undo-notice"),
              h.Class(UNDO_ALERT_CLASS),
            ],
            [
              h.div(
                [h.DataAttribute("slot", "alert-description")],
                [
                  `${notice.action} ${notice.entries.length} thread${notice.entries.length === 1 ? "" : "s"}, `,
                  h.button(
                    [
                      h.Type("button"),
                      h.DataAttribute("slot", "inline-button"),
                      h.OnClick(Message.ClickedUndo()),
                      h.Class(INLINE_BUTTON_CLASS),
                    ],
                    [model.isMac ? "⌘Z to undo" : "Ctrl+Z to undo"]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
  });

const connectionLabel = (state: string): string => {
  switch (state) {
    case "Live": {
      return "Live";
    }

    case "Syncing": {
      return "Syncing";
    }

    case "Backoff": {
      return "Reconnecting";
    }

    default: {
      return "Connecting";
    }
  }
};

const footer = (h: H, model: Model): Html =>
  h.div(
    [
      h.Class("flex flex-col gap-2 px-[var(--sidebar-content-inset)] py-1"),
      h.DataAttribute("sidebar", "footer"),
      h.DataAttribute("slot", "sidebar-footer"),
    ],
    [
      h.ul(
        [
          h.Class("flex w-full min-w-0 gap-1 flex-row items-center"),
          h.DataAttribute("sidebar", "menu"),
          h.DataAttribute("slot", "sidebar-menu"),
        ],
        [
          h.li(
            [
              h.Class("group/menu-item relative shrink-0"),
              h.DataAttribute("slot", "sidebar-menu-item"),
            ],
            [
              h.a(
                [
                  h.Href(settingsRouter()),
                  h.AriaLabel("Settings"),
                  h.Class(FOOTER_ICON_BUTTON_CLASS),
                  h.DataAttribute("sidebar", "menu-button"),
                ],
                [icon(h, "settings")]
              ),
            ]
          ),
          h.li(
            [
              h.Class("group/menu-item relative shrink-0"),
              h.DataAttribute("slot", "sidebar-menu-item"),
            ],
            [
              h.a(
                [
                  h.Href(settingsRouter()),
                  h.AriaLabel("Usage"),
                  h.Class(FOOTER_ICON_BUTTON_CLASS),
                  h.DataAttribute("sidebar", "menu-button"),
                ],
                [icon(h, "chart-no-axes-column")]
              ),
            ]
          ),
          h.li(
            [h.Class("group/menu-item relative ml-auto shrink-0")],
            [
              h.span(
                [
                  h.DataAttribute("testid", "connection-state"),
                  h.DataAttribute("state", model.context.connection),
                  h.Role("status"),
                  h.Class(
                    cx(
                      "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium",
                      model.context.connection === "Live"
                        ? "text-sidebar-muted-foreground/70"
                        : "bg-sidebar-control-surface text-sidebar-foreground"
                    )
                  ),
                ],
                [
                  h.span(
                    [
                      h.AriaHidden(true),
                      h.Class(
                        cx(
                          "size-1.5 rounded-full",
                          model.context.connection === "Live"
                            ? "bg-success"
                            : "bg-warning"
                        )
                      ),
                    ],
                    []
                  ),
                  connectionLabel(model.context.connection),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );

/**
 * Every project and thread id the shell holds, for the judges that compare the page with the
 * brain. Not shown and not read aloud.
 */
const shellIndex = (h: H, model: Model): Html =>
  Option.match(model.context.shell, {
    onNone: () => h.empty,
    onSome: (shell) =>
      h.div(
        [
          h.AriaHidden(true),
          h.DataAttribute("testid", "shell-list"),
          h.DataAttribute("sequence", String(shell.snapshotSequence)),
          h.Class("sr-only"),
        ],
        [
          ...shell.projects.map((project) =>
            h.span(
              [
                h.Key(`project-${project.id}`),
                h.DataAttribute("testid", "shell-project"),
                h.DataAttribute("project-id", project.id),
              ],
              []
            )
          ),
          ...shell.threads.map((thread) =>
            h.span(
              [
                h.Key(`thread-${thread.id}`),
                h.DataAttribute("testid", "shell-thread-row"),
                h.DataAttribute("thread-id", thread.id),
                h.DataAttribute("activity", thread.activity),
              ],
              [thread.title]
            )
          ),
        ]
      ),
  });

const SHEET_TRIGGER_CLASS =
  "[&_svg]:-mx-0.5 inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[var(--control-radius)] border font-medium text-base outline-none transition-[box-shadow,scale] [&:not([aria-haspopup]):not(:disabled):not([aria-disabled=true])]:will-change-[scale] [&:active:not([aria-haspopup])]:scale-[0.97] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--control-radius)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-64 aria-disabled:cursor-not-allowed aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='text-'])]:text-[var(--control-icon-color)] [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 size-9 sm:size-8 [--control-icon-color:currentColor] z-20 border-transparent text-sidebar-foreground/90 [:hover,[data-pressed]]:bg-sidebar-row-hover focus-visible:ring-ring size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag] relative top-auto translate-y-0";

/** The phone's sidebar toggle, as t3code places it at the top left of the page and the sheet. */
const sheetTrigger = (h: H, isPressed: boolean): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(SHEET_TRIGGER_CLASS),
      h.DataAttribute("slot", "sidebar-trigger"),
      h.DataAttribute("sidebar", "trigger"),
      h.AriaPressed(isPressed ? "true" : "false"),
      h.AriaLabel("Toggle main sidebar"),
      h.OnClick(Message.ClickedToggleSheet()),
    ],
    [
      icon(h, "panel-left", "size-4"),
      h.span([h.Class("sr-only")], ["Toggle Sidebar"]),
    ]
  );

/** The sidebar's column: brand band, header, list or results, undo notice and footer. */
const column = (h: H, model: Model): ReadonlyArray<Html> => [
  h.div(
    [h.Class(CHROME_HEADER_CLASS)],
    [
      h.div(
        [
          h.Class(
            "relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden"
          ),
        ],
        [sheetTrigger(h, model.isSheetOpen)]
      ),
      h.div(
        [
          h.Class(
            "relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5"
          ),
        ],
        [
          h.a(
            [
              h.Href(inboxRouter()),
              h.AriaLabel("Go to threads"),
              h.DataAttribute("testid", "sidebar-brand"),
              h.Class(
                "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex text-sidebar-foreground"
              ),
            ],
            [
              h.span(
                [h.Class("truncate text-sm font-medium tracking-tight")],
                ["Cairn"]
              ),
            ]
          ),
        ]
      ),
    ]
  ),
  h.div(
    [h.Class("w-full shrink-0")],
    [
      h.div(
        [
          h.Class(cx(GROUP_CLASS, "z-[1]")),
          h.DataAttribute("sidebar", "group"),
          h.DataAttribute("slot", "sidebar-group"),
        ],
        [headerView(h, model)]
      ),
    ]
  ),
  h.div(
    [h.Role("presentation"), h.Class(SCROLL_ROOT_CLASS)],
    [
      h.div(
        [
          h.Role("presentation"),
          h.DataAttribute("slot", "scroll-area-viewport"),
          h.OnMount(ScrollFade()),
          h.Class(SCROLL_VIEWPORT_CLASS),
        ],
        [
          h.div(
            [
              h.Class(CONTENT_CLASS),
              h.DataAttribute("sidebar", "content"),
              h.DataAttribute("slot", "sidebar-content"),
            ],
            [
              h.div(
                [
                  h.Class(cx(GROUP_CLASS, "flex-1")),
                  h.DataAttribute("sidebar", "group"),
                  h.DataAttribute("slot", "sidebar-group"),
                  h.Role("presentation"),
                ],
                [
                  isSearching(model)
                    ? searchResults(h, model)
                    : threadList(h, model),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  ),
  undoNotice(h, model),
  footer(h, model),
];

const menu = (h: H, model: Model): Html =>
  Option.match(model.contextMenu, {
    onNone: () => h.empty,
    onSome: (open) =>
      MenuTarget.match(open.target, {
        Thread: ({ threadId }) =>
          Option.match(findThread(model, threadId), {
            onNone: () => h.empty,
            onSome: (thread) =>
              contextMenuView(h, open, threadMenuOf(model, thread)),
          }),
        Draft: ({ draftId }) => {
          const hasPath = model.context.drafts.some(
            (draft) =>
              draft.draftId === draftId && Option.isSome(draft.projectId)
          );

          return contextMenuView(
            h,
            open,
            buildDraftActionMenuItems({ hasPath })
          );
        },
      }),
  });

const sheet = (h: H, model: Model): Html =>
  model.isMobile && model.isSheetOpen
    ? h.div(
        [h.DataAttribute("testid", "sidebar-sheet")],
        [
          h.div(
            [
              h.DataAttribute("slot", "sheet-backdrop"),
              h.Class(SHEET_BACKDROP_CLASS),
              h.OnClick(Message.ClickedSheetBackdrop()),
            ],
            []
          ),
          h.div(
            [
              h.DataAttribute("slot", "sheet-viewport"),
              h.Class(SHEET_VIEWPORT_CLASS),
            ],
            [
              h.div(
                [
                  h.Role("dialog"),
                  h.AriaLabel("Sidebar"),
                  h.DataAttribute("slot", "sidebar"),
                  h.DataAttribute("mobile", "true"),
                  h.DataAttribute("sidebar", "sidebar"),
                  // Outside the desktop column's `--sidebar-width`, the sheet sizes to its content,
                  // as t3code's portaled sheet does.
                  h.Class(SHEET_POPUP_CLASS),
                ],
                [
                  h.div(
                    [
                      h.Class(SHEET_COLUMN_CLASS),
                      h.DataAttribute("app-sidebar", ""),
                      h.Role("navigation"),
                      h.AriaLabel("Threads"),
                    ],
                    column(h, model)
                  ),
                ]
              ),
            ]
          ),
        ]
      )
    : h.empty;

/** The sidebar, as a desktop column and, on a phone, a sheet. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div(
    [h.DataAttribute("testid", "sidebar"), h.Class("contents")],
    [
      h.div(
        [
          h.Class(SIDEBAR_ROOT_CLASS),
          h.DataAttribute("collapsible", model.isOpen ? "" : "offcanvas"),
          h.DataAttribute("side", "left"),
          h.DataAttribute("slot", "sidebar"),
          h.DataAttribute("state", model.isOpen ? "expanded" : "collapsed"),
          h.DataAttribute("variant", "sidebar"),
          h.Style({
            "--sidebar-width": SIDEBAR_WIDTH,
            "--sidebar-width-icon": "3rem",
            "--workspace-titlebar-content-left":
              "calc(var(--workspace-controls-left) + var(--workspace-titlebar-control-size) + var(--workspace-titlebar-control-gap))",
          }),
        ],
        [
          h.div([
            h.Class(SIDEBAR_GAP_CLASS),
            h.DataAttribute("slot", "sidebar-gap"),
          ]),
          h.div(
            [
              h.Class(SIDEBAR_CONTAINER_CLASS),
              h.DataAttribute("slot", "sidebar-container"),
              h.DataAttribute("app-sidebar", ""),
              h.Role("navigation"),
              h.AriaLabel("Threads"),
              ...(model.isOpen ? [] : [h.Inert(true)]),
            ],
            [
              h.div(
                [
                  h.Class(SIDEBAR_INNER_CLASS),
                  h.DataAttribute("sidebar", "sidebar"),
                  h.DataAttribute("slot", "sidebar-inner"),
                ],
                column(h, model)
              ),
            ]
          ),
        ]
      ),
      model.isSheetOpen
        ? h.empty
        : h.div(
            [
              h.DataAttribute("testid", "sidebar-sheet-toggle"),
              h.Class(
                "fixed top-[calc((var(--workspace-topbar-height)-var(--workspace-titlebar-control-size))/2)] left-[var(--workspace-controls-left)] z-20 flex md:hidden"
              ),
            ],
            [sheetTrigger(h, false)]
          ),
      sheet(h, model),
      menu(h, model),
      Option.match(model.addProject, {
        onNone: () => h.empty,
        onSome: (dialog) => addProjectView(h, dialog),
      }),
      shellIndex(h, model),
    ]
  )
);
