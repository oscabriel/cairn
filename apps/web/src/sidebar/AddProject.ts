// The add-project dialog: a folder browser over `projects.browse`, starting at the home folder.
// Clicking a folder opens it; "Add" makes the shown folder a project. t3code adds projects through
// its command palette; Cairn draws its dialog look (backdrop, card, header, panel, footer) instead.

import { Option } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { buttonClass } from "../ui/Button.ts";
import {
  DIALOG_BACKDROP_CLASS,
  DIALOG_MOBILE_SHEET_CLASS,
  DIALOG_POPUP_CLASS,
  DIALOG_VIEWPORT_CLASS,
} from "../ui/Dialog.ts";
import { icon } from "./Icons.ts";
import { Message } from "./Message.ts";
import { Listing } from "./Model.ts";
import type { AddProjectDialog } from "./Model.ts";
import { cx } from "./Row.ts";

type H = HtmlBuilder<Message>;

const folderRow = (
  h: H,
  inputs: {
    readonly name: string;
    readonly path: string;
    readonly isGitRepo: boolean;
  }
): Html =>
  h.li(
    [h.Key(inputs.path), h.Class("list-none")],
    [
      h.button(
        [
          h.Type("button"),
          h.DataAttribute("testid", "add-project-folder"),
          h.DataAttribute("path", inputs.path),
          h.OnClick(Message.ClickedFolder({ path: inputs.path })),
          h.Class(
            "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
          ),
        ],
        [
          icon(
            h,
            inputs.isGitRepo ? "folder-git-2" : "folder",
            "size-4 shrink-0 text-muted-foreground"
          ),
          h.span([h.Class("min-w-0 flex-1 truncate")], [inputs.name]),
        ]
      ),
    ]
  );

const body = (h: H, dialog: AddProjectDialog): Html =>
  Listing.match(dialog.listing, {
    Loading: () =>
      h.p(
        [h.Role("status"), h.Class("text-muted-foreground text-sm")],
        ["Loading folders..."]
      ),
    Failed: ({ message }) =>
      h.p(
        [h.Role("alert"), h.Class("text-destructive-foreground text-sm")],
        [message]
      ),
    Loaded: ({ result }) =>
      h.div(
        [h.Class("flex flex-col gap-2")],
        [
          h.div(
            [h.Class("flex min-w-0 items-center gap-2")],
            [
              Option.match(result.parent, {
                onNone: () => h.empty,
                onSome: (parent) =>
                  h.button(
                    [
                      h.Type("button"),
                      h.AriaLabel("Parent folder"),
                      h.OnClick(Message.ClickedFolder({ path: parent })),
                      h.Class(buttonClass("ghost", "icon-sm")),
                    ],
                    [icon(h, "corner-left-up")]
                  ),
              }),
              h.code(
                [
                  h.DataAttribute("testid", "add-project-path"),
                  h.Class("min-w-0 truncate text-xs"),
                ],
                [result.path]
              ),
            ]
          ),
          h.ul(
            [h.Class("flex max-h-72 flex-col gap-px overflow-y-auto")],
            result.entries.length === 0
              ? [
                  h.li(
                    [
                      h.Class(
                        "list-none px-2 py-1 text-muted-foreground text-sm"
                      ),
                    ],
                    ["No folders here."]
                  ),
                ]
              : result.entries.map((entry) =>
                  folderRow(h, {
                    name: entry.name,
                    path: entry.path,
                    isGitRepo: entry.isGitRepo,
                  })
                )
          ),
        ]
      ),
  });

const shownPath = (dialog: AddProjectDialog): Option.Option<string> =>
  Listing.match(dialog.listing, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Loaded: ({ result }) => Option.some(result.path),
  });

/** The add-project dialog. */
export const addProjectView = (h: H, dialog: AddProjectDialog): Html =>
  h.div(
    [
      h.DataAttribute("testid", "add-project-dialog"),
      h.OnKeyDownPreventDefault((key) =>
        key === "Escape"
          ? Option.some(Message.DismissedAddProject())
          : Option.none()
      ),
    ],
    [
      h.div(
        [
          h.Class(DIALOG_BACKDROP_CLASS),
          h.OnClick(Message.DismissedAddProject()),
        ],
        []
      ),
      h.div(
        [
          h.DataAttribute("slot", "dialog-viewport"),
          h.Class(DIALOG_VIEWPORT_CLASS),
        ],
        [
          h.div(
            [
              h.Role("dialog"),
              h.AriaModal(true),
              h.AriaLabel("Add project"),
              h.DataAttribute("slot", "dialog-popup"),
              h.Class(
                cx(
                  DIALOG_POPUP_CLASS,
                  "row-start-2 text-popover-foreground max-h-full max-w-lg",
                  DIALOG_MOBILE_SHEET_CLASS
                )
              ),
            ],
            [
              h.div(
                [
                  h.DataAttribute("slot", "dialog-header"),
                  h.Class("flex flex-col gap-2 p-6 max-sm:pb-4"),
                ],
                [
                  h.h2(
                    [
                      h.Class(
                        "wrap-anywhere font-semibold text-xl leading-none"
                      ),
                    ],
                    ["Add project"]
                  ),
                  h.p(
                    [h.Class("text-muted-foreground text-sm")],
                    [
                      "Choose a folder on the Beelink. Its threads will start there.",
                    ]
                  ),
                ]
              ),
              h.div(
                [
                  h.DataAttribute("slot", "dialog-panel"),
                  h.Class("space-y-4 px-6 pb-2"),
                ],
                [body(h, dialog)]
              ),
              h.div(
                [
                  h.DataAttribute("slot", "dialog-footer"),
                  h.Class(
                    "flex flex-col-reverse gap-2 px-6 sm:flex-row sm:justify-end sm:rounded-b-[calc(var(--radius-2xl)-1px)] border-t bg-muted/72 py-4"
                  ),
                ],
                [
                  h.button(
                    [
                      h.Type("button"),
                      h.OnClick(Message.DismissedAddProject()),
                      h.Class(buttonClass("ghost", "default")),
                    ],
                    ["Cancel"]
                  ),
                  ...Option.match(shownPath(dialog), {
                    onNone: () => [],
                    onSome: (path) => [
                      h.button(
                        [
                          h.Type("button"),
                          h.DataAttribute("testid", "add-project-confirm"),
                          h.OnClick(Message.ClickedAddFolder({ path })),
                          h.Class(buttonClass("default", "default")),
                        ],
                        ["Add this folder"]
                      ),
                    ],
                  }),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );
