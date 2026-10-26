// Ported from github.com/pingdotgg/t3code, apps/web/src/components/ChatView.tsx (the draft hero
// layout, lines 8359 to 8470) at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the chat column
// with its page header (breadcrumb: project, slash, "New thread") above the workspace drop target,
// the composer overlay centred in it, the headline sitting above the card, the context strip under
// it, and the safe-area spacer; with no projects, the no-projects hero instead. Changed: no
// view-transition names (the docking animation is optional in this cut), no panel toggles in the
// header (a draft has no details panel or terminal), and the page is the composer's own view.
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

import { cardView } from "../composer/Card.ts";
import { draftProject } from "../composer/Drafts.ts";
import type { Message } from "../composer/Message.ts";
import type { Model } from "../composer/Model.ts";
import { CHAT_COLUMN_CLASS, chatHeader } from "../ui/ChatHeader.ts";
import { contextStripView } from "./ContextStripView.ts";
import { hasNoProjects, headlineView, noProjectsView } from "./Headline.ts";

/** The new-thread page's header: the draft's project and "New thread". */
const header = (model: Model, h: HtmlBuilder<Message>): Html =>
  chatHeader(h, {
    project: Option.map(
      Option.filter(
        draftProject(model),
        (project) => project.kind === "folder"
      ),
      (project) => ({
        title: project.title,
        ariaLabel: `New thread in ${project.title}`,
        onClick: Option.none(),
      })
    ),
    title: "New thread",
    controls: [],
  });

/** The chat column: the page header above the canvas, as t3code lays out every chat page. */
const column = (model: Model, h: HtmlBuilder<Message>, canvas: Html): Html =>
  h.div(
    [
      h.DataAttribute("chat-column-maximized-away", "false"),
      h.DataAttribute("chat-column", "true"),
      h.Class(CHAT_COLUMN_CLASS),
    ],
    [
      header(model, h),
      h.div(
        [
          h.DataAttribute("testid", "hero"),
          h.Class("relative flex min-h-0 min-w-0 flex-1"),
        ],
        [canvas]
      ),
    ]
  );

/** The new-thread page: the headline and the composer centred, or the no-projects hero. */
export const heroView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const inScratch = Option.exists(
    draftProject(model),
    (project) => project.kind === "scratch"
  );

  if (hasNoProjects(model) && !inScratch) {
    return column(model, h, noProjectsView(h));
  }

  return column(
    model,
    h,
    h.div(
      [
        h.DataAttribute("chat-workspace-drop-target", "true"),
        h.DataAttribute("chat-canvas", "true"),
        h.Class("relative flex min-h-0 min-w-0 flex-1 flex-col"),
      ],
      [
        // The empty timeline under the overlay: opaque, as t3code's, so the frame's grain stays
        // behind it.
        h.div(
          [h.Class("relative flex min-h-0 flex-1 flex-col bg-background")],
          [h.div([h.Class("h-full min-h-0 bg-background")])]
        ),
        h.div(
          [
            h.DataAttribute("chat-composer-overlay", "true"),
            h.Class(
              "pointer-events-none absolute inset-0 z-20 flex items-center"
            ),
          ],
          [
            h.div(
              [h.Class("chat-composer-lane w-full")],
              [
                h.div(
                  [
                    h.DataAttribute("chat-composer-stack", "true"),
                    h.Class(
                      "group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-content-max-width)"
                    ),
                  ],
                  [
                    h.div(
                      [h.Class("absolute inset-x-0 bottom-full")],
                      [h.div([h.Class("pb-4")], [headlineView(model, h)])]
                    ),
                    h.div(
                      [h.Class("relative z-10")],
                      [cardView(model, contextStripView(model, h), h)]
                    ),
                    h.div([
                      h.Attribute("aria-hidden", "true"),
                      h.Class(
                        "h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                      ),
                    ]),
                  ]
                ),
              ]
            ),
          ]
        ),
      ]
    )
  );
};
