// The `next` hero's headline (plan look track L7): what a new thread asks, above the composer box.
// Classic's headline (`hero/Headline.ts`, a port of t3code's draft hero) measures whether "What
// should we build in <project>?" fits on one line and folds it in two when it does not; here the
// question and the project are always two parts, so nothing is measured and nothing can spill:
// the question is one line of display type that wraps on a narrow phone, and under it the project
// picker, a pill that names where the thread will run, beside "or start without a project". Both
// are at least `--hit-target` tall on a coarse pointer.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import { Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ChevronDown, FolderPlus, Plus } from "lucide";

import { draftProject, pickableProjects } from "../../composer/Drafts.ts";
import { icon } from "../../composer/Icon.ts";
import { Message } from "../../composer/Message.ts";
import { Popover } from "../../composer/Model.ts";
import type { Model } from "../../composer/Model.ts";
import { classNames } from "../../ui/ClassNames.ts";
import { button, buttonDefaults } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING,
  HIT_TARGET,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";

const HEADING_CLASS = classNames(
  "w-full text-balance text-center text-ink-1 [overflow-wrap:anywhere]",
  TYPE.display,
  WEIGHT_STRONG
);

const PICKER_CLASS = classNames(
  "inline-flex h-8 max-w-full min-w-0 cursor-pointer items-center gap-(--space-1-5) rounded-(--radius-small) bg-select-2 px-(--space-2) text-ink-1 hover:bg-select-3 data-popup-open:bg-select-3 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-ink-3",
  TYPE.ui,
  WEIGHT_MEDIUM,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

const QUIET_CLASS = classNames(
  "inline-flex h-8 cursor-pointer items-center rounded-(--radius-small) px-(--space-2) text-ink-2 hover:text-ink-1 hover:bg-select-1",
  TYPE.ui,
  HIT_TARGET,
  FOCUS_RING,
  FEEDBACK_MOTION
);

const projectPicker = (
  model: Model,
  name: string,
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
      ...onlyIf(open, h.DataAttribute("popup-open", "")),
      h.AriaHasPopup("listbox"),
      h.AriaExpanded(open),
      h.Class(PICKER_CLASS),
      h.OnClick(
        Message.OpenedPopover({
          popover: Popover.Project({ query: "", highlighted: Option.none() }),
        })
      ),
    ],
    [
      h.span([h.Class("min-w-0 truncate")], [name]),
      icon(h, ChevronDown, "chevron-down", ""),
    ]
  );
};

const startWithoutProject = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type("button"),
      h.DataAttribute("testid", "hero-start-without-project"),
      h.Class(QUIET_CLASS),
      h.OnClick(Message.ClickedStartWithoutProject()),
    ],
    ["or start without a project"]
  );

const choices = (
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.Class(
        "flex w-full min-w-0 flex-wrap items-center justify-center gap-x-(--space-2) gap-y-(--space-1)"
      ),
    ],
    children
  );

/** The draft hero's headline above the composer box. */
export const headlineView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const project = draftProject(model);

  const isScratch = Option.exists(
    project,
    (current) => current.kind === "scratch"
  );

  const name = Option.match(project, {
    onNone: () => "Choose a project",
    onSome: (current) => (isScratch ? "No project" : current.title),
  });

  return h.div(
    [
      h.DataAttribute("testid", "hero-headline"),
      h.Class(
        "mx-auto flex w-full min-w-0 flex-col items-center gap-(--space-3)"
      ),
    ],
    [
      h.h1(
        [h.Class(HEADING_CLASS)],
        [isScratch ? "What should we work on?" : "What should we build?"]
      ),
      choices(
        isScratch
          ? [projectPicker(model, name, h)]
          : [
              h.span([h.Class(`text-ink-3 ${TYPE.ui}`)], ["in"]),
              projectPicker(model, name, h),
              startWithoutProject(h),
            ],
        h
      ),
    ]
  );
};

/** True when there is no folder project to offer, so the hero asks for one first. */
export const hasNoProjects = (model: Model): boolean =>
  pickableProjects(model).length === 0;

/** The hero with no projects: what to do before the first thread. */
export const noProjectsView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.DataAttribute("testid", "hero-no-projects"),
      h.Class("flex flex-1 items-center justify-center p-(--space-6)"),
    ],
    [
      h.div(
        [
          h.Class(
            "flex w-full max-w-lg flex-col items-center gap-(--space-3) text-center"
          ),
        ],
        [
          h.h1([h.Class(HEADING_CLASS)], ["What should we work on?"]),
          h.p(
            [h.Class(`text-ink-2 ${TYPE.body}`)],
            ["Add a project, or start without one."]
          ),
          h.div(
            [
              h.Class(
                "mt-(--space-3) flex flex-wrap justify-center gap-(--space-2)"
              ),
            ],
            [
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "primary",
                  onClick: Option.some(Message.ClickedAddProject()),
                  attributes: [h.DataAttribute("testid", "hero-add-project")],
                },
                [icon(h, Plus, "plus", "size-4"), "Add project"]
              ),
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  onClick: Option.some(Message.ClickedStartWithoutProject()),
                  attributes: [h.DataAttribute("testid", "hero-start-scratch")],
                },
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
