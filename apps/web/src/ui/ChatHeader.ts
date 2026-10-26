// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ChatHeader.tsx and
// apps/web/src/components/WorkspaceBreadcrumb.tsx at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92.
// Kept: the page header band (`data-chat-header`) with its gutters, the breadcrumb's DOM and class
// strings (project crumb with its monogram, the slash, the current page as an `h2`), and the fixed
// titlebar controls slot at the top right. Changed: a Foldkit view over any message type; the
// project crumb acts only when the caller gives it a message; the panel toggles are the caller's
// (Cairn has no thread details panel or terminal drawer).
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

import { projectMark } from "./ProjectMark.ts";

/** The header band above a chat column. */
export const CHAT_HEADER_CLASS =
  "relative bg-background [[data-panel-animations=true]_&]:motion-safe:transition-[padding-left] [[data-panel-animations=true]_&]:motion-safe:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:motion-safe:ease-out flex h-[var(--workspace-topbar-height)] min-h-[var(--workspace-topbar-height)] shrink-0 items-center pl-(--workspace-gutter-start) pr-(--workspace-gutter-end) [[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/** The chat column: the header above the page's canvas. */
export const CHAT_COLUMN_CLASS =
  "flex min-h-0 min-w-0 flex-col overflow-x-hidden flex-1";

/** The fixed slot at the top right that holds a page's panel toggles. */
export const TITLEBAR_CONTROLS_CLASS =
  "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]";

/** A ghost icon button in the titlebar controls, as t3code's panel toggles. */
export const TITLEBAR_BUTTON_CLASS =
  "[&_svg]:-mx-0.5 relative inline-flex cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-base outline-none transition-shadow before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none aria-disabled:opacity-64 sm:text-sm [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0 h-8 min-w-8 px-[calc(--spacing(1.5)-1px)] sm:h-7 sm:min-w-7 border-transparent text-foreground shadow-none [:disabled,:active,[data-pressed]]:shadow-none before:shadow-none data-pressed:bg-accent data-pressed:text-accent-foreground disabled:opacity-100 disabled:text-muted-foreground disabled:[&_svg]:opacity-100 shrink-0 [-webkit-app-region:no-drag]";

const CRUMB_TEXT_CLASS =
  "block min-w-0 truncate [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1.5";

const PROJECT_CRUMB_CLASS =
  "inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm text-muted-foreground transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The project crumb: its title and, when given, what clicking it does. */
export interface ProjectCrumb<Message> {
  readonly title: string;
  readonly ariaLabel: string;
  readonly onClick: Option.Option<Message>;
}

/** What one page header shows. */
export interface ChatHeaderInput<Message> {
  readonly project: Option.Option<ProjectCrumb<Message>>;
  /** The current page: a thread's title, or "New thread". */
  readonly title: string;
  /** The panel toggles at the top right, if the page has any. */
  readonly controls: ReadonlyArray<Html>;
}

const crumbText = <Message>(
  h: HtmlBuilder<Message>,
  text: string,
  extra = ""
): Html =>
  h.span(
    [
      h.DataAttribute("slot", "workspace-breadcrumb-text"),
      h.Class(extra === "" ? CRUMB_TEXT_CLASS : `${CRUMB_TEXT_CLASS} ${extra}`),
    ],
    [text]
  );

const projectCrumb = <Message>(
  h: HtmlBuilder<Message>,
  crumb: ProjectCrumb<Message>
): Html => {
  const children = [
    projectMark(
      h,
      crumb.title,
      "inline-flex shrink-0 items-center justify-center size-3.5"
    ),
    crumbText(h, crumb.title, "max-w-40"),
  ];

  return Option.match(crumb.onClick, {
    onNone: () =>
      h.span(
        [
          h.DataAttribute("slot", "tooltip-trigger"),
          h.Class(PROJECT_CRUMB_CLASS),
        ],
        children
      ),
    onSome: (message) =>
      h.button(
        [
          h.Type("button"),
          h.AriaLabel(crumb.ariaLabel),
          h.DataAttribute("slot", "tooltip-trigger"),
          h.Class(
            `${PROJECT_CRUMB_CLASS} cursor-pointer hover:text-foreground`
          ),
          h.OnClick(message),
        ],
        children
      ),
  });
};

/** The breadcrumb: the project (when there is one), a slash, and the current page. */
const breadcrumb = <Message>(
  h: HtmlBuilder<Message>,
  input: ChatHeaderInput<Message>
): Html =>
  h.nav(
    [
      h.AriaLabel("Thread breadcrumb"),
      h.Class("min-w-0 flex-1 overflow-clip [overflow-clip-margin:2px]"),
    ],
    [
      h.ol(
        [
          h.Class(
            "m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm sm:gap-3"
          ),
        ],
        [
          ...Option.match(input.project, {
            onNone: () => [],
            onSome: (crumb) => [
              h.li(
                [
                  h.Class(
                    "flex min-w-0 items-center font-medium text-muted-foreground shrink"
                  ),
                ],
                [projectCrumb(h, crumb)]
              ),
              h.li(
                [
                  h.AriaHidden(true),
                  h.Class("flex shrink-0 items-center text-icon-muted"),
                ],
                [crumbText(h, "/")]
              ),
            ],
          }),
          h.li(
            [
              h.AriaCurrent("page"),
              h.Class(
                "flex items-center font-medium text-foreground min-w-10 flex-1"
              ),
            ],
            [
              h.h2(
                [
                  h.AriaLabel(input.title),
                  h.DataAttribute("slot", "tooltip-trigger"),
                  h.Class("min-w-0 flex-1"),
                ],
                [crumbText(h, input.title)]
              ),
            ]
          ),
        ]
      ),
    ]
  );

/** The page header above a chat column: the titlebar controls and the breadcrumb. */
export const chatHeader = <Message>(
  h: HtmlBuilder<Message>,
  input: ChatHeaderInput<Message>
): Html =>
  h.header(
    [h.DataAttribute("chat-header", "true"), h.Class(CHAT_HEADER_CLASS)],
    [
      input.controls.length === 0
        ? h.empty
        : h.div(
            [
              h.DataAttribute("workspace-titlebar-controls", "true"),
              h.Class(TITLEBAR_CONTROLS_CLASS),
            ],
            [
              h.div(
                [h.Class("pointer-events-auto flex h-full items-center")],
                [
                  h.div(
                    [
                      h.DataAttribute("panel-layout-controls", "true"),
                      h.Class(
                        "flex h-full shrink-0 items-center gap-1 [-webkit-app-region:no-drag]"
                      ),
                    ],
                    input.controls
                  ),
                ]
              ),
            ]
          ),
      h.div(
        [h.Class("flex min-w-0 flex-1 items-center gap-2 sm:gap-3 pr-24")],
        [breadcrumb(h, input)]
      ),
    ]
  );
