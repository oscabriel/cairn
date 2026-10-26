// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/settings/settingsLayout.tsx (SettingsSection, SettingsRow,
// SettingsPageContainer), apps/web/src/components/settings/SettingsGroup.tsx and
// apps/web/src/components/WorkspacePageContainer.tsx (the readable width),
// apps/web/src/components/settings/SettingsBreadcrumb.tsx (the page header), the classes the
// settings panels in SettingsPanels.tsx are built from. Kept: every class string of the page
// header and breadcrumb, the section header, the grouped card, the row's container-query grid and
// the page's scroll and width. Changed: Foldkit views; the breadcrumb is the one crumb "Settings"
// (Cairn has one settings page); the search-target scrolling, scope line, scope inheritance,
// override badges, reset buttons and "Restore device defaults" are left out, because Cairn has one
// scope and no settings search.
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

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import type { Child } from "../ui/Child.ts";
import { classNames } from "../ui/ClassNames.ts";

/** The page's scroll area. */
export const PAGE_SCROLL_CLASS =
  "topbar-scroll-fade [scrollbar-gutter:stable_both-edges] flex-1 overflow-y-auto";

/** The page's column: `WorkspacePageContainer` at the readable width, with the settings gap. */
export const PAGE_COLUMN_CLASS =
  "mx-auto flex w-full flex-col px-5 pt-6 pb-12 sm:px-6 max-w-4xl gap-8";

const SECTION_HEADER_CLASS =
  "flex min-h-7 items-start justify-between gap-4 px-3 sm:px-4";

const SECTION_TITLE_CLASS =
  "flex min-h-7 items-center gap-2 text-sm font-normal text-foreground/70";

/** The grouped card, divided between rows. */
export const GROUP_CLASS =
  "relative overflow-visible text-foreground rounded-xl border border-border/60 bg-card/40 shadow-xs/5 [&>*+*]:border-t [&>*+*]:border-border/50 [&>[data-slot=settings-row]]:rounded-none";

const ROW_GRID_CLASS =
  "flex flex-col gap-3 @min-[32rem]/settings-row:grid @min-[32rem]/settings-row:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @min-[32rem]/settings-row:items-center";

const ROW_CONTROL_CLASS =
  "flex w-full min-w-0 shrink-0 items-center gap-2 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:justify-end";

const HEADER_CLASS =
  "flex h-[var(--workspace-topbar-height)]! min-h-[var(--workspace-topbar-height)]! max-h-[var(--workspace-topbar-height)]! shrink-0 items-center gap-3 pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left,padding-right] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/** The page header: t3code's settings breadcrumb, with Cairn's one settings page as its crumb. */
export const settingsHeader = <Message>(h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class(HEADER_CLASS)],
    [
      h.div(
        [h.Class("flex w-full items-center gap-3")],
        [
          h.nav(
            [h.AriaLabel("Settings breadcrumb"), h.Class("min-w-0")],
            [
              h.ol(
                [
                  h.Class(
                    "m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3"
                  ),
                ],
                [
                  h.li(
                    [
                      h.AriaCurrent("page"),
                      h.Class(
                        "flex min-w-0 items-center font-medium text-foreground truncate"
                      ),
                    ],
                    ["Settings"]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );

/** The scrolling page and its column. */
export const settingsPage = <Message>(
  h: HtmlBuilder<Message>,
  children: ReadonlyArray<Child>
): Html =>
  h.div(
    [h.Class("min-h-0 flex flex-1 flex-col")],
    [
      h.div(
        [
          h.DataAttribute("settings-page-scroll", ""),
          h.Class(PAGE_SCROLL_CLASS),
        ],
        [h.div([h.Class(PAGE_COLUMN_CLASS)], children)]
      ),
    ]
  );

/** A titled section whose rows share one card. */
export const settingsSection = <Message>(
  h: HtmlBuilder<Message>,
  config: {
    readonly id: string;
    readonly title: string;
    readonly headerAction: Option.Option<Html>;
  },
  rows: ReadonlyArray<Child>
): Html =>
  h.section(
    [
      h.Id(config.id),
      h.DataAttribute("testid", `settings-section-${config.id}`),
      h.Class("space-y-2.5"),
    ],
    [
      h.div(
        [
          h.DataAttribute("settings-scroll-target", ""),
          h.Class(SECTION_HEADER_CLASS),
        ],
        [
          h.div(
            [h.Class("flex min-w-0 items-center gap-1")],
            [h.h2([h.Class(SECTION_TITLE_CLASS)], [config.title])]
          ),
          h.div(
            [h.Class("flex min-h-7 min-w-7 items-center justify-end")],
            [Option.getOrElse(config.headerAction, () => h.empty)]
          ),
        ]
      ),
      h.div([h.Class(GROUP_CLASS)], rows),
    ]
  );

/** One row's content. */
export interface SettingsRowConfig {
  readonly id: string;
  readonly title: string;
  readonly description: Option.Option<string>;
  readonly status: Option.Option<Child>;
  readonly control: Option.Option<Html>;
}

/** A row: title, description and status on the left, its control on the right (stacked when narrow). */
export const settingsRow = <Message>(
  h: HtmlBuilder<Message>,
  config: SettingsRowConfig,
  children: ReadonlyArray<Child> = []
): Html =>
  h.div(
    [
      h.DataAttribute("slot", "settings-row"),
      h.DataAttribute("settings-row", config.id),
      h.Class(
        classNames(
          "@container/settings-row rounded-xl px-3 sm:px-4 aria-disabled:opacity-64 aria-disabled:[&_*]:text-muted-foreground",
          children.length > 0 ? "pt-3 pb-1" : "py-3"
        )
      ),
    ],
    [
      h.div(
        [h.Class(ROW_GRID_CLASS)],
        [
          h.div(
            [h.Class("min-w-0 flex-1 space-y-1")],
            [
              h.div(
                [h.Class("flex min-h-5 items-center gap-1.5")],
                [
                  h.h3(
                    [h.Class("text-sm font-medium text-foreground")],
                    [config.title]
                  ),
                ]
              ),
              Option.match(config.description, {
                onNone: () => h.empty,
                onSome: (description) =>
                  h.p(
                    [
                      h.Class(
                        "max-w-xl text-xs leading-normal text-muted-foreground/80"
                      ),
                    ],
                    [description]
                  ),
              }),
              Option.match(config.status, {
                onNone: () => h.empty,
                onSome: (status) =>
                  h.div(
                    [
                      h.DataAttribute("testid", `settings-status-${config.id}`),
                      h.Class("pt-0.5 text-xs text-muted-foreground"),
                    ],
                    [status]
                  ),
              }),
            ]
          ),
          Option.match(config.control, {
            onNone: () => h.empty,
            onSome: (control) => h.div([h.Class(ROW_CONTROL_CLASS)], [control]),
          }),
        ]
      ),
      ...children,
    ]
  );
