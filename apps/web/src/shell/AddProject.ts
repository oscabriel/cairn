// The add-project picker, opened by the rail's + bubble and the hero's Add project: a folder on the
// Beelink, typed or browsed to, becomes a project. It is the sheet in its dialog shape: a
// sheet from the bottom edge on a phone, from `md` a dialog under the top of the window, which
// takes focus on its first control (not the field, so a phone's keyboard stays down while the user
// browses). The listing comes from `projects.browse` (folders only, under the home folder); a folder
// entered (a row) or Up lists it and makes it the one to add. Every row and button is at
// least `--hit-target` tall on a coarse pointer.

import { onlyIf } from "@cairn/client-logic/OnlyIf";
import type { BrowseResult } from "@cairn/protocol/Projects";
import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { ArrowUp, Folder, GitBranch } from "lucide";

import { buttonDefaults, button } from "../ui/Button.ts";
import {
  FEEDBACK_MOTION,
  FOCUS_WITHIN_RING,
  HIT_HEIGHT,
  TYPE,
  WEIGHT_MEDIUM,
} from "../ui/Classes.ts";
import { classNames } from "../ui/ClassNames.ts";
import { glyph } from "../ui/Glyph.ts";
import { row, rowDefaults } from "../ui/Row.ts";
import { placedSheet, sheetDefaults } from "../ui/Sheet.ts";
import type { SheetPlacement } from "../ui/Sheet.ts";
import { folderOf } from "./Derived.ts";
import { Message } from "./Message.ts";
import { FolderListing } from "./Model.ts";
import type { AddProjectState } from "./Model.ts";

/** The picker's id; its dialog's and its title's ids derive from it. */
const ADD_PROJECT_ID = "add-project";

const FIELD_ID = "add-project-folder";

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
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  variant: "ghost",
                  size: "small",
                  onClick: Option.some(
                    Message.ClickedBrowseFolder({ path: parent })
                  ),
                  ariaLabel: Option.some("Up to the folder above"),
                  attributes: [h.DataAttribute("testid", "add-project-up")],
                },
                [glyph(h, ArrowUp, "arrow-up", "small"), "Up"]
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
                  row(
                    h,
                    {
                      ...rowDefaults<Message>(),
                      onClick: Option.some(
                        Message.ClickedBrowseFolder({ path: entry.path })
                      ),
                      attributes: [
                        h.DataAttribute("testid", "add-project-entry"),
                      ],
                    },
                    {
                      leading: Option.some(
                        h.span(
                          [h.Class("text-ink-3")],
                          [glyph(h, Folder, "folder", "regular")]
                        )
                      ),
                      title: entry.name,
                      meta: Option.none(),
                      hint: Option.none(),
                      trailing: entry.isGitRepo
                        ? [
                            h.span(
                              [
                                h.Role("img"),
                                h.AriaLabel("git checkout"),
                                h.Class("px-(--space-1) text-ink-3"),
                              ],
                              [glyph(h, GitBranch, "git-branch", "small")]
                            ),
                          ]
                        : [],
                    }
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
        [
          h.For(FIELD_ID),
          h.Class(classNames("text-ink-1", TYPE.ui, WEIGHT_MEDIUM)),
        ],
        ["Folder"]
      ),
      h.div(
        [
          h.DataAttribute("slot", "field-shell"),
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

const body = (h: HtmlBuilder<Message>, state: AddProjectState): Html =>
  h.div(
    [h.Class("flex min-h-0 flex-1 flex-col gap-(--space-3)")],
    [
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
    ]
  );

const actions = (
  h: HtmlBuilder<Message>,
  state: AddProjectState
): ReadonlyArray<Html> => [
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "ghost",
      onClick: Option.some(Message.ClickedCancelAddProject()),
      attributes: [h.DataAttribute("testid", "add-project-cancel")],
    },
    ["Cancel"]
  ),
  button(
    h,
    {
      ...buttonDefaults<Message>(),
      variant: "primary",
      onClick: Option.some(Message.SubmittedAddProject()),
      isDisabled: folderOf(state.folder, state.home) === "",
      isBusy: Option.isSome(state.adding),
      attributes: [h.DataAttribute("testid", "add-project-submit")],
    },
    ["Add project"]
  ),
];

/** The picker, while it is open; nothing otherwise. */
export const addProjectPicker = (
  h: HtmlBuilder<Message>,
  addProject: Option.Option<AddProjectState>,
  placement: SheetPlacement
): Html =>
  Option.match(addProject, {
    onNone: () => h.empty,
    onSome: (state) =>
      placedSheet(
        h,
        placement,
        {
          ...sheetDefaults<Message>(ADD_PROJECT_ID, "Add project"),
          kind: "dialog",
          // The listing scrolls on its own inside the sheet's body.
          layout: "fill",
          role: "dialog",
          focusSelector: Option.none(),
          onClose: Message.ClickedCancelAddProject(),
          onSettled: Message.SettledOverlay(),
          panelClass:
            "h-[min(36rem,85dvh)] md:h-[min(34rem,calc(100dvh-8rem))]",
          attributes: [h.DataAttribute("testid", "add-project")],
        },
        [
          h.div(
            [h.Class("flex min-h-0 flex-1 flex-col p-(--space-4)")],
            [body(h, state)]
          ),
        ],
        actions(h, state)
      ),
  });
