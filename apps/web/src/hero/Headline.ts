// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/chat/{DraftHeroHeadline,DraftHeroProjectHeading,DraftProjectName}.tsx and
// apps/web/src/components/NoProjectsHero.tsx. Kept: "What should we build in <project>?" with the
// project as a dotted-underline picker, measured against a hidden full-width copy so it sits inline
// at `lg` when it fits and drops below otherwise; "or start without a project" under it; "What
// should we work on?" for a scratch draft, with the picker in the sub-line; and, with no projects,
// "What should we work on?" with Add project and Start without a project. Changed: the measuring is a
// Foldkit Mount reporting `MeasuredHeadline`; the picker is the composer's popover.
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

import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { FolderPlus, Plus } from "lucide";

import { draftProject, pickableProjects } from "../composer/Drafts.ts";
import { icon } from "../composer/Icon.ts";
import { MeasureHeadline } from "../composer/MeasureHeadline.ts";
import { Message } from "../composer/Message.ts";
import { Popover } from "../composer/Model.ts";
import type { Model } from "../composer/Model.ts";

const PICKER_CLASS =
  "inline-flex shrink-0 cursor-pointer items-center font-medium [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 gap-1.5 text-foreground underline decoration-foreground/30 decoration-dotted decoration-from-font underline-offset-4 hover:decoration-foreground hover:decoration-solid data-popup-open:decoration-foreground data-popup-open:decoration-solid pointer-events-auto min-w-0 max-w-full align-baseline";

const MUTED_INLINE_CLASS =
  "inline-flex shrink-0 cursor-pointer items-center gap-0.5 font-medium underline-offset-2 [text-align:var(--inline-button-text-align,center)] [white-space:var(--inline-button-white-space,nowrap)] hover:underline focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64 text-muted-foreground hover:text-foreground pointer-events-auto";

const projectName = (h: HtmlBuilder<Message>, value: string): Html =>
  h.span(
    [h.AriaLabel(value), h.Class("min-w-0 block truncate text-left")],
    [value]
  );

const projectPicker = (
  model: Model,
  label: string,
  h: HtmlBuilder<Message>
): Html => {
  const open = Option.exists(model.popover, (popover) =>
    Predicate.isTagged(popover, "Project")
  );

  return h.button(
    [
      h.Type("button"),
      h.DataAttribute("draft-project-trigger", ""),
      h.DataAttribute("testid", "hero-project-trigger"),
      ...(open ? [h.DataAttribute("popup-open", "")] : []),
      h.AriaHasPopup("listbox"),
      h.AriaExpanded(open),
      h.Class(PICKER_CLASS),
      h.OnClick(
        Message.OpenedPopover({
          popover: Popover.Project({ query: "", highlighted: Option.none() }),
        })
      ),
    ],
    [projectName(h, label)]
  );
};

const startWithoutProject = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class("mt-2 flex h-6 w-full items-center justify-center text-sm")],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "hero-start-without-project"),
          h.Class(MUTED_INLINE_CLASS),
          h.OnClick(Message.ClickedStartWithoutProject()),
        ],
        ["or start without a project"]
      ),
    ]
  );

/** The draft hero's headline above the composer card. */
export const headlineView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const project = draftProject(model);

  const isScratch = Option.exists(
    project,
    (current) => current.kind === "scratch"
  );

  if (isScratch) {
    return h.div(
      [
        h.DataAttribute("testid", "hero-headline"),
        h.Class("mx-auto flex w-full max-w-5xl flex-col items-center"),
      ],
      [
        h.h1(
          [
            h.Class(
              "w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
            ),
          ],
          ["What should we work on?"]
        ),
        h.p(
          [h.Class("mt-2 flex h-6 w-full items-center justify-center text-sm")],
          [projectPicker(model, "No project", h)]
        ),
      ]
    );
  }

  const name = Option.match(project, {
    onNone: () => "Choose a project",
    onSome: (current) => current.title,
  });

  return h.div(
    [
      h.DataAttribute("testid", "hero-headline"),
      h.Class("mx-auto flex w-full max-w-5xl flex-col items-center"),
    ],
    [
      h.div(
        [
          h.Class("group/draft-hero relative w-full"),
          h.DataAttribute("inline", String(model.headlineInline)),
          h.OnMount(MeasureHeadline()),
        ],
        [
          h.span(
            [
              h.Attribute("aria-hidden", "true"),
              h.Class(
                "pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden"
              ),
            ],
            [
              h.span(
                [
                  h.DataAttribute("headline-measure", ""),
                  h.Class(
                    "flex w-max items-baseline gap-2 whitespace-nowrap font-normal text-3xl tracking-tight"
                  ),
                ],
                [
                  h.span([], ["What should we build in"]),
                  h.span([], [h.span([h.Class("font-medium")], [name]), "?"]),
                ]
              ),
            ]
          ),
          h.h1(
            [
              h.Class(
                "flex w-full flex-col items-center justify-center gap-2 text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl lg:group-data-[inline=true]/draft-hero:flex-row"
              ),
            ],
            [
              h.span(
                [
                  h.Class(
                    "max-w-full lg:group-data-[inline=true]/draft-hero:shrink-0"
                  ),
                ],
                [
                  "What should we build",
                  h.span(
                    [h.Class("lg:group-data-[inline=true]/draft-hero:hidden")],
                    ["?"]
                  ),
                  h.span(
                    [
                      h.Class(
                        "hidden lg:group-data-[inline=true]/draft-hero:inline"
                      ),
                    ],
                    [" in"]
                  ),
                ]
              ),
              h.span(
                [
                  h.Class(
                    "flex min-w-0 max-w-full items-baseline justify-center text-base tracking-normal lg:group-data-[inline=true]/draft-hero:text-3xl lg:group-data-[inline=true]/draft-hero:tracking-tight"
                  ),
                ],
                [
                  h.span([h.Class("min-w-0")], [projectPicker(model, name, h)]),
                  h.span(
                    [
                      h.Class(
                        "hidden shrink-0 lg:group-data-[inline=true]/draft-hero:inline"
                      ),
                    ],
                    ["?"]
                  ),
                ]
              ),
            ]
          ),
        ]
      ),
      startWithoutProject(h),
    ]
  );
};

const BUTTON_CLASS =
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg border font-medium text-sm outline-none h-8 px-3 focus-visible:ring-2 focus-visible:ring-ring";

/** True when there is no folder project to offer, so the hero asks for one first. */
export const hasNoProjects = (model: Model): boolean =>
  pickableProjects(model).length === 0;

/** t3code's no-projects hero: what to do before the first thread. */
export const noProjectsView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("testid", "hero-no-projects"),
      h.Class("flex flex-1 items-center justify-center"),
    ],
    [
      h.div(
        [h.Class("w-full max-w-lg px-8 py-12 text-center")],
        [
          h.h1([h.Class("font-semibold text-xl")], ["What should we work on?"]),
          h.p(
            [h.Class("mt-2 text-muted-foreground text-sm")],
            ["Add a project, or start without one."]
          ),
          h.div(
            [h.Class("mt-6 flex justify-center gap-2")],
            [
              h.button(
                [
                  h.Type("button"),
                  h.DataAttribute("testid", "hero-add-project"),
                  h.Class(
                    `${BUTTON_CLASS} border-primary bg-primary text-primary-foreground hover:bg-primary/90`
                  ),
                  h.OnClick(Message.ClickedAddProject()),
                ],
                [icon(h, Plus, "plus", "size-4"), "Add project"]
              ),
              h.button(
                [
                  h.Type("button"),
                  h.DataAttribute("testid", "hero-start-scratch"),
                  h.Class(
                    `${BUTTON_CLASS} border-input bg-background hover:bg-accent`
                  ),
                  h.OnClick(Message.ClickedStartWithoutProject()),
                ],
                [
                  icon(h, FolderPlus, "folder-plus", "size-4"),
                  "Start without a project",
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
