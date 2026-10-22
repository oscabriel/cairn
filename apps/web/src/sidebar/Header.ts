// Ported from github.com/pingdotgg/t3code, apps/web/src/components/sidebar/SidebarThreadHeader.tsx
// and the project filter combobox in apps/web/src/components/Sidebar.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: one row with the search field (a combobox over the
// results, cleared with its X), the project filter, "Add project" and "New thread", each icon button
// with its 3rem touch target, and the filter popup's search field and options ("All projects", then
// each project). Changed: Foldkit views; the filter popup is drawn under the search field by the
// sidebar rather than positioned by Base UI; the per-project settings button is not ported (no
// project settings page yet).
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
import type { ProjectShell } from "@cairn/protocol/Shell";
import { Option } from "effect";
import type { Attribute, Html, HtmlBuilder } from "foldkit/html";

import { COMBOBOX_ITEM_CLASS, COMBOBOX_POPUP_CLASS } from "../ui/Combobox.ts";
import { projectMark } from "../ui/ProjectMark.ts";
import {
  CLEAR_SEARCH_CLASS,
  HEADER_ICON_BUTTON_CLASS,
  SEARCH_CONTROL_CLASS,
  SEARCH_FIELD_CLASS,
  SEARCH_INPUT_CLASS,
  TOUCH_TARGET_CLASS,
} from "./Classes.ts";
import {
  findProject,
  isSearching,
  projectsOf,
  searchResultsOf,
} from "./Derived.ts";
import { icon } from "./Icons.ts";
import type { IconName } from "./Icons.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { cx } from "./Row.ts";

type H = HtmlBuilder<Message>;

const SEARCH_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape"]);

const iconButton = (
  h: H,
  inputs: {
    readonly label: string;
    readonly onClick: Message;
    readonly content: Html;
    readonly extra: ReadonlyArray<Attribute<Message>>;
  }
): Html =>
  h.button(
    [
      h.Type("button"),
      h.Class(HEADER_ICON_BUTTON_CLASS),
      h.DataAttribute("active", "false"),
      h.DataAttribute("sidebar", "menu-button"),
      h.DataAttribute("size", "icon"),
      h.AriaLabel(inputs.label),
      h.Attribute("title", inputs.label),
      h.OnClick(inputs.onClick),
      ...inputs.extra,
    ],
    [inputs.content, h.span([h.AriaHidden(true), h.Class(TOUCH_TARGET_CLASS)])]
  );

const plainIcon = (h: H, name: IconName, className = ""): Html =>
  icon(h, name, className);

const searchField = (h: H, model: Model): Html => {
  const searching = isSearching(model);
  const resultCount = searching ? searchResultsOf(model).length : 0;
  const resultsVisible = searching && resultCount > 0;

  return h.div(
    [h.Class(SEARCH_FIELD_CLASS)],
    [
      plainIcon(h, "search", "size-4 shrink-0 text-(--sidebar-icon-color)"),
      h.span(
        [
          h.Class(SEARCH_CONTROL_CLASS),
          h.DataAttribute("size", "default"),
          h.DataAttribute("slot", "input-control"),
        ],
        [
          h.input([
            h.Class(SEARCH_INPUT_CLASS),
            h.DataAttribute("slot", "input"),
            h.Placeholder("Search"),
            h.AriaLabel("Search threads"),
            h.Role("combobox"),
            h.Attribute("aria-autocomplete", "list"),
            h.AriaExpanded(resultsVisible),
            ...(resultsVisible
              ? [h.AriaControls("sidebar-thread-search-results")]
              : []),
            ...(resultsVisible && model.activeSearchIndex < resultCount
              ? [
                  h.AriaActiveDescendant(
                    `sidebar-thread-search-result-${model.activeSearchIndex}`
                  ),
                ]
              : []),
            h.Type("search"),
            h.Value(model.search),
            h.OnInput((value) => Message.ChangedSearch({ value })),
            h.OnKeyDownPreventDefault((key) =>
              SEARCH_KEYS.has(key)
                ? Option.some(Message.PressedSearchKey({ key }))
                : Option.none()
            ),
          ]),
        ]
      ),
      searching
        ? h.button(
            [
              h.Type("button"),
              h.Class(CLEAR_SEARCH_CLASS),
              h.DataAttribute("slot", "button"),
              h.AriaLabel("Clear thread search"),
              h.OnClick(Message.ClickedClearSearch()),
            ],
            [plainIcon(h, "x", "size-3")]
          )
        : h.empty,
    ]
  );
};

const filterTriggerContent = (h: H, model: Model): Html =>
  Option.match(
    Option.flatMap(model.projectFilter, (projectId) =>
      findProject(model, projectId)
    ),
    {
      onNone: () => plainIcon(h, "list-filter", "size-4"),
      onSome: (project) =>
        h.span(
          [h.Class("flex shrink-0")],
          [
            projectMark(
              h,
              project.title,
              "inline-flex shrink-0 items-center justify-center size-4"
            ),
          ]
        ),
    }
  );

const filterOption = (
  h: H,
  inputs: {
    readonly label: string;
    readonly selected: boolean;
    readonly mark: Html;
    readonly project: Option.Option<ProjectShell>;
  }
): Html =>
  h.div(
    [
      h.Role("option"),
      h.AriaSelected(inputs.selected),
      ...(inputs.selected ? [h.DataAttribute("selected", "")] : []),
      h.DataAttribute("slot", "combobox-item"),
      h.Class(COMBOBOX_ITEM_CLASS),
      h.OnClick(
        Message.ChoseProjectFilter({
          projectId: Option.map(inputs.project, (project) => project.id),
        })
      ),
    ],
    [
      h.div(
        [
          h.DataAttribute("slot", "combobox-item-content"),
          h.Class(
            "flex min-w-0 flex-1 items-center gap-2 [&_svg:not([class*='text-'])]:text-muted-foreground"
          ),
        ],
        [
          inputs.mark,
          h.span([h.Class("min-w-0 flex-1 truncate text-sm")], [inputs.label]),
        ]
      ),
    ]
  );

const filterPopup = (h: H, model: Model, query: string): Html => {
  const needle = query.trim().toLowerCase();

  const projects = projectsOf(model).filter(
    (project) =>
      project.kind === "folder" &&
      (needle.length === 0 || project.title.toLowerCase().includes(needle))
  );

  return h.div(
    [
      h.DataAttribute("slot", "combobox-positioner"),
      h.DataAttribute("testid", "sidebar-project-filter"),
      h.Class("absolute top-11 left-2 z-[130] select-none"),
      h.OnKeyDownPreventDefault((key) =>
        key === "Escape"
          ? Option.some(Message.DismissedFilterMenu())
          : Option.none()
      ),
    ],
    [
      h.span(
        [
          h.Class(
            cx(
              COMBOBOX_POPUP_CLASS,
              "min-w-[calc(var(--sidebar-width)-105px)] max-w-[min(18rem,var(--available-width))] overflow-hidden"
            )
          ),
        ],
        [
          h.div(
            [
              h.Role("dialog"),
              h.DataAttribute("slot", "combobox-popup"),
              h.Class(
                "flex min-w-0 max-h-[23rem] flex-1 flex-col overflow-hidden text-foreground"
              ),
            ],
            [
              h.div(
                [h.Class("min-w-0 shrink-0 px-3 pt-2.5")],
                [
                  h.div(
                    [
                      h.Class(
                        "relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring"
                      ),
                    ],
                    [
                      plainIcon(
                        h,
                        "search",
                        "pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                      ),
                      h.input([
                        h.Class(
                          "w-full min-w-0 rounded-[inherit] bg-transparent ps-5 text-sm outline-none placeholder:text-placeholder h-7.5 leading-7.5 sm:h-6.5 sm:leading-6.5"
                        ),
                        h.AriaLabel("Search projects"),
                        h.Placeholder("Search projects..."),
                        h.Type("text"),
                        h.Value(query),
                        h.Autofocus(true),
                        h.OnInput((value) =>
                          Message.ChangedFilterQuery({ value })
                        ),
                      ]),
                    ]
                  ),
                ]
              ),
              projects.length === 0 && needle.length > 0
                ? h.div(
                    [
                      h.Role("status"),
                      h.Class(
                        "p-2 text-center text-base text-muted-foreground sm:text-sm"
                      ),
                    ],
                    ["No matching projects."]
                  )
                : h.empty,
              h.div(
                [
                  h.Role("listbox"),
                  h.DataAttribute("slot", "combobox-list"),
                  h.Class("overflow-auto px-1 py-1"),
                ],
                [
                  needle.length === 0
                    ? filterOption(h, {
                        label: "All projects",
                        selected: Option.isNone(model.projectFilter),
                        mark: plainIcon(h, "folder", "size-4 shrink-0"),
                        project: Option.none(),
                      })
                    : h.empty,
                  ...projects.map((project) =>
                    filterOption(h, {
                      label: project.title,
                      selected: Option.contains(
                        model.projectFilter,
                        project.id
                      ),
                      mark: projectMark(
                        h,
                        project.title,
                        "inline-flex items-center justify-center size-4 shrink-0"
                      ),
                      project: Option.some(project),
                    })
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
};

/** The header row: search, project filter, Add project and New thread. */
export const headerView = (h: H, model: Model): Html =>
  h.div(
    [h.Class("flex items-center gap-1")],
    [
      searchField(h, model),
      h.div(
        [h.Class("flex shrink-0 items-center")],
        [
          ...(projectsOf(model).length > 0
            ? [
                iconButton(h, {
                  label: "Filter threads by project",
                  onClick: Message.ClickedFilterTrigger(),
                  content: filterTriggerContent(h, model),
                  extra: [
                    h.Role("combobox"),
                    h.AriaExpanded(Option.isSome(model.filterMenu)),
                    h.AriaHasPopup("dialog"),
                    h.DataAttribute("slot", "combobox-trigger"),
                  ],
                }),
                iconButton(h, {
                  label: "Add project",
                  onClick: Message.ClickedAddProject(),
                  content: plainIcon(h, "folder-plus"),
                  extra: [h.DataAttribute("slot", "tooltip-trigger")],
                }),
              ]
            : []),
          iconButton(h, {
            label: "New thread",
            onClick: Message.ClickedNewThread(),
            content: plainIcon(h, "square-pen"),
            extra: [h.DataAttribute("slot", "tooltip-trigger")],
          }),
        ]
      ),
      Option.match(model.filterMenu, {
        onNone: () => h.empty,
        onSome: ({ query }) => filterPopup(h, model, query),
      }),
    ]
  );
