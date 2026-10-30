// The add-project picker, opened by the rail's + bubble and the hero's Add project: a folder on the
// Beelink, typed or browsed to, becomes a project. On a phone it is a sheet from the bottom edge;
// from `md` it is a dialog under the top of the window. The listing comes from `projects.browse`
// (folders only, under the home folder); a folder entered or Up lists it and makes it the one to
// add. Every row and button is at least `--hit-target` tall on a coarse pointer.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type { BrowseResult } from "@cairn/protocol/Projects";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ArrowUp, Folder, GitBranch } from "lucide";

import { classNames } from "../../ui/ClassNames.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_RING_INSET,
  FOCUS_WITHIN_RING,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
  WEIGHT_STRONG,
} from "../ui/Classes.ts";
import { glyph } from "../ui/Glyph.ts";
import { folderOf } from "./Derived.ts";
import { Message } from "./Message.ts";
import { FolderListing } from "./Model.ts";
import type { AddProjectState } from "./Model.ts";
import type { Placement } from "./Scratch.ts";
import { positionOf } from "./Scratch.ts";

/** The picker's id, which takes focus when it opens. */
export const ADD_PROJECT_ID = "add-project";

const TITLE_ID = "add-project-title";

const FIELD_ID = "add-project-folder";

const ROW_BASE = classNames(
  "flex min-w-0 cursor-pointer items-center gap-(--space-2) rounded-(--radius-small) px-(--space-2) py-(--space-1-5) text-start text-ink-1 hover:bg-select-1",
  TYPE.ui,
  HIT_HEIGHT,
  FOCUS_RING_INSET,
  FEEDBACK_MOTION
);

const ROW = classNames(ROW_BASE, "w-full");

const note = (h: HtmlBuilder<Message>, words: string): Html =>
  h.p(
    [h.Class(classNames("px-(--space-2) py-(--space-3) text-ink-3", TYPE.ui))],
    [words]
  );

const entries = (h: HtmlBuilder<Message>, result: BrowseResult): Html =>
  h.div(
    [h.Class("flex min-h-0 flex-1 flex-col")],
    [
      h.div(
        [
          h.Class(
            "flex min-w-0 items-center gap-(--space-2) border-b border-stroke-1 px-(--space-1) py-(--space-1)"
          ),
        ],
        [
          Option.match(result.parent, {
            onNone: () => h.empty,
            onSome: (parent) =>
              h.button(
                [
                  h.Type("button"),
                  h.DataAttribute("testid", "add-project-up"),
                  h.AriaLabel("Up to the folder above"),
                  h.OnClick(Message.ClickedBrowseFolder({ path: parent })),
                  h.Class(classNames(ROW_BASE, "shrink-0 text-ink-2")),
                ],
                [glyph(h, ArrowUp, "arrow-up", "regular"), "Up"]
              ),
          }),
          h.span(
            [
              h.DataAttribute("testid", "add-project-path"),
              h.Class(
                classNames(
                  "min-w-0 truncate font-(family-name:--font-code) text-ink-3",
                  TYPE.small
                )
              ),
            ],
            [result.path]
          ),
        ]
      ),
      result.entries.length === 0
        ? note(h, "No folders here.")
        : h.ul(
            [
              h.AriaLabel("Folders"),
              h.Class(
                "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-(--space-1)"
              ),
            ],
            result.entries.map((entry) =>
              h.li(
                [h.Key(entry.path)],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.DataAttribute("testid", "add-project-entry"),
                      h.OnClick(
                        Message.ClickedBrowseFolder({ path: entry.path })
                      ),
                      h.Class(ROW),
                    ],
                    [
                      h.span(
                        [h.Class("text-ink-3")],
                        [glyph(h, Folder, "folder", "regular")]
                      ),
                      h.span(
                        [h.Class("min-w-0 flex-1 truncate")],
                        [entry.name]
                      ),
                      entry.isGitRepo
                        ? h.span(
                            [
                              h.AriaLabel("git checkout"),
                              h.Class("text-ink-3"),
                            ],
                            [glyph(h, GitBranch, "git-branch", "small")]
                          )
                        : h.empty,
                    ]
                  ),
                ]
              )
            )
          ),
    ]
  );

const listing = (h: HtmlBuilder<Message>, state: AddProjectState): Html =>
  h.div(
    [
      h.DataAttribute("testid", "add-project-listing"),
      h.Class(
        "flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--radius-small) border border-stroke-1 bg-surface-sunken"
      ),
    ],
    [
      FolderListing.match(state.listing, {
        Loading: () => note(h, "Listing folders..."),
        Loaded: ({ result }) => entries(h, result),
        Failed: ({ message }) => note(h, message),
      }),
    ]
  );

const field = (h: HtmlBuilder<Message>, state: AddProjectState): Html =>
  h.div(
    [h.Class("flex flex-col gap-(--space-1-5)")],
    [
      h.label(
        [h.For(FIELD_ID), h.Class(classNames(TYPE.ui, WEIGHT_MEDIUM))],
        ["Folder"]
      ),
      h.div(
        [
          h.Class(
            classNames(
              "flex rounded-(--radius-small) border border-stroke-2 bg-surface-sunken px-(--space-2)",
              FOCUS_WITHIN_RING,
              FEEDBACK_MOTION
            )
          ),
        ],
        [
          h.input([
            h.Id(FIELD_ID),
            h.DataAttribute("testid", "add-project-folder"),
            h.Type("text"),
            h.Placeholder("~/Developer/my-project"),
            h.Autocomplete("off"),
            h.Spellcheck(false),
            h.Value(state.folder),
            h.OnInput((value) => Message.ChangedAddProjectFolder({ value })),
            h.OnKeyDownPreventDefault((key) =>
              key === "Enter"
                ? Option.some(Message.SubmittedAddProject())
                : Option.none()
            ),
            h.Class(
              classNames(
                "h-9 min-w-0 flex-1 bg-transparent font-(family-name:--font-code) text-ink-1 outline-none placeholder:text-ink-3",
                TYPE.ui,
                HIT_HEIGHT
              )
            ),
          ]),
        ]
      ),
    ]
  );

/** The picker and its scrim, while it is open; nothing otherwise. */
export const addProjectPicker = (
  h: HtmlBuilder<Message>,
  addProject: Option.Option<AddProjectState>,
  placement: Placement
): Html =>
  Option.match(addProject, {
    onNone: () => h.empty,
    onSome: (state) => {
      const position = positionOf(placement);
      const isBlank = folderOf(state.folder, state.home) === "";

      return h.div(
        [h.DataAttribute("slot", "add-project"), h.Class("contents")],
        [
          h.div([
            h.AriaHidden(true),
            h.OnClick(Message.ClickedCancelAddProject()),
            h.Class(classNames(position, "inset-0 z-(--layer-scrim) bg-scrim")),
          ]),
          h.section(
            [
              h.Id(ADD_PROJECT_ID),
              h.DataAttribute("testid", "add-project"),
              h.Role("dialog"),
              h.AriaModal(true),
              h.AriaLabelledBy(TITLE_ID),
              h.Tabindex(-1),
              h.Class(
                classNames(
                  position,
                  "z-(--layer-sheet) flex flex-col gap-(--space-3) border border-stroke-2 bg-surface-overlay p-(--space-4) text-ink-1 shadow-(--elevation-3) outline-none",
                  // A sheet from the bottom edge on a phone; a dialog from `md`.
                  "inset-x-0 bottom-0 h-[min(36rem,85dvh)] rounded-t-(--radius-large) pb-[max(env(safe-area-inset-bottom),var(--space-4))]",
                  "md:inset-x-(--space-3) md:top-24 md:bottom-auto md:mx-auto md:h-[min(34rem,calc(100dvh-8rem))] md:max-w-lg md:rounded-(--radius-large) md:pb-(--space-4)"
                )
              ),
            ],
            [
              h.h2(
                [
                  h.Id(TITLE_ID),
                  h.Class(classNames(TYPE.title, WEIGHT_STRONG)),
                ],
                ["Add project"]
              ),
              h.p(
                [h.Class(classNames("text-ink-2", TYPE.ui))],
                [
                  "Pick a folder on the Beelink, or type its path. A folder that is already a project opens that project.",
                ]
              ),
              field(h, state),
              listing(h, state),
              ...onlyIf(
                Option.isSome(state.failure),
                h.p(
                  [
                    h.Role("alert"),
                    h.DataAttribute("testid", "add-project-failure"),
                    h.Class(classNames("text-ink-1", TYPE.ui)),
                  ],
                  [Option.getOrElse(state.failure, () => "")]
                )
              ),
              h.div(
                [
                  h.Class(
                    "flex flex-wrap items-center justify-end gap-(--space-2)"
                  ),
                ],
                [
                  button(
                    h,
                    {
                      ...buttonDefaults<Message>(),
                      variant: "ghost",
                      onClick: Option.some(Message.ClickedCancelAddProject()),
                      attributes: [
                        h.DataAttribute("testid", "add-project-cancel"),
                      ],
                    },
                    ["Cancel"]
                  ),
                  button(
                    h,
                    {
                      ...buttonDefaults<Message>(),
                      variant: "primary",
                      onClick: Option.some(Message.SubmittedAddProject()),
                      isDisabled: isBlank,
                      isBusy: state.isAdding,
                      attributes: [
                        h.DataAttribute("testid", "add-project-submit"),
                      ],
                    },
                    ["Add project"]
                  ),
                ]
              ),
            ]
          ),
        ]
      );
    },
  });
