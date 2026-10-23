// Ported from github.com/pingdotgg/t3code at fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92:
// apps/web/src/components/chat/{ModelPickerContent,ProviderModelPicker}.tsx (the picker's search
// field, grouped rows with name, provider and favourite star), TraitsPicker.tsx, the runtime-mode
// select and BranchToolbar.tsx's workspace and branch menus. Kept: the popup glass, search field
// and row class strings and the favourites-first grouping. Changed: one popover is open at a time
// and it is the composer's own state (Base UI's popovers portal and anchor themselves; this one
// opens beside the composer card); the provider rail is a heading per provider; keyboard moves
// through the rows from the search field.
// The hero's project combobox is ported from apps/web/src/components/chat/DraftHeroHeadline.tsx
// (the "Search projects..." field, folder marks and "Add project" with FolderPlus) and
// apps/web/src/components/ui/combobox.tsx (the positioner and popup). Kept: the popup and row
// class strings and the row order. Changed: the popup is positioned by hand, `-top-11` against
// the composer card where Base UI anchors it to the headline's project button; the first row is
// always the highlighted one, so Enter picks it (Base UI highlights on keyboard or hover only).
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
import { modelPickerModelKey } from "@cairn/client-logic/ModelSearch";
import type { ProjectId } from "@cairn/protocol/Ids";
import type { ModelListing } from "@cairn/protocol/Models";
import { Array, Option, Predicate } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";
import { Folder, FolderPlus, Search, Star } from "lucide";

import { filterBranches, resolveEnvModeLabel } from "../hero/ContextStrip.ts";
import {
  COMBOBOX_ITEM_CLASS,
  COMBOBOX_LIST_CLASS,
  COMBOBOX_POPUP_CLASS,
} from "../ui/Combobox.ts";
import { MENU_ITEM_CLASS, POPUP_CLASS } from "./Classes.ts";
import { activeDraft, isDraftTarget, pickableProjects } from "./Drafts.ts";
import { modeItems, overflowItems, thinkingItems } from "./Footer.ts";
import { icon } from "./Icon.ts";
import { Message } from "./Message.ts";
import { Popover } from "./Model.ts";
import type { Model } from "./Model.ts";
import { modelGroups, resolvedModel } from "./Models.ts";

const ROW_CLASS =
  "flex min-h-8 items-center rounded-sm px-2 py-1 text-base outline-none not-data-disabled:hover:bg-accent data-disabled:pointer-events-none data-disabled:cursor-not-allowed data-selected:bg-foreground/[0.08] data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm group relative w-full !min-w-0 max-w-full cursor-pointer";

const STAR_CLASS =
  "relative inline-flex cursor-pointer items-center justify-center rounded-[var(--control-radius)] border border-transparent outline-none size-7 sm:size-6 text-muted-foreground hover:bg-accent hover:text-foreground -mr-1 shrink-0";

const SEARCH_INPUT_CLASS =
  "w-full min-w-0 rounded-[inherit] bg-transparent outline-none placeholder:text-placeholder h-7.5 ps-5 leading-7.5 text-sm sm:h-6.5 sm:leading-6.5";

/** The rows of the open model picker, in display order, for keyboard movement. */
export const pickerRows = (model: Model): ReadonlyArray<ModelListing> =>
  Option.match(model.popover, {
    onNone: () => [],
    onSome: (popover) =>
      Popover.match(popover, {
        ModelPicker: ({ query }) =>
          Array.dedupeWith(
            Array.flatMap(modelGroups(model, query), (group) => group.models),
            (left: ModelListing, right: ModelListing) =>
              left.provider === right.provider && left.modelId === right.modelId
          ),
        Thinking: () => [],
        RuntimeMode: () => [],
        Overflow: () => [],
        Project: () => [],
        EnvMode: () => [],
        Branch: () => [],
      }),
  });

const listingKey = (listing: ModelListing): string =>
  modelPickerModelKey(listing.provider, listing.modelId);

/** The row the keyboard is on: the one moved to, else the current model, else the first. */
const highlightedKey = (
  model: Model,
  highlighted: Option.Option<string>
): Option.Option<string> => {
  const keys = pickerRows(model).map(listingKey);

  const current = Option.map(resolvedModel(model), (ref) =>
    modelPickerModelKey(ref.provider, ref.modelId)
  );

  return Option.orElse(
    Option.orElse(
      Option.filter(highlighted, (key) => keys.includes(key)),
      () => Option.filter(current, (key) => keys.includes(key))
    ),
    () => Array.head(keys)
  );
};

/** The key a picker's arrow or Enter acts on. */
export const pickerKeyMessage = (
  model: Model,
  key: string
): Option.Option<Message> => {
  const highlighted = Option.flatMap(model.popover, (popover) =>
    Popover.match(popover, {
      ModelPicker: ({ highlighted: current }) => highlightedKey(model, current),
      Thinking: () => Option.none(),
      RuntimeMode: () => Option.none(),
      Overflow: () => Option.none(),
      Project: () => Option.none(),
      EnvMode: () => Option.none(),
      Branch: () => Option.none(),
    })
  );

  const rows = pickerRows(model);

  const index = Option.match(highlighted, {
    onNone: () => -1,
    onSome: (current) => rows.findIndex((row) => listingKey(row) === current),
  });

  switch (key) {
    case "Escape": {
      return Option.some(Message.ClosedPopover());
    }

    case "ArrowDown":
    case "ArrowUp": {
      const step = key === "ArrowDown" ? 1 : -1;

      const next =
        rows[(index + step + rows.length) % Math.max(1, rows.length)];

      return Option.map(Option.fromUndefinedOr(next), (row) =>
        Message.MovedPopoverHighlight({ id: listingKey(row) })
      );
    }

    case "Enter": {
      return Option.map(Option.fromUndefinedOr(rows[index]), (row) =>
        Message.PickedModel({
          model: { provider: row.provider, modelId: row.modelId },
        })
      );
    }

    default: {
      return Option.none();
    }
  }
};

const searchField = (
  h: HtmlBuilder<Message>,
  query: string,
  placeholder: string,
  onKey: (key: string) => Option.Option<Message>
): Html =>
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
          icon(
            h,
            Search,
            "search",
            "pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          ),
          h.input([
            h.Type("text"),
            h.Placeholder(placeholder),
            h.AriaLabel(placeholder),
            h.Autocomplete("off"),
            h.Spellcheck(false),
            h.Autofocus(true),
            h.DataAttribute("testid", "composer-popover-search"),
            h.Value(query),
            h.Class(SEARCH_INPUT_CLASS),
            h.OnInput((value) => Message.ChangedPopoverQuery({ query: value })),
            h.OnKeyDownPreventDefault((key) => onKey(key)),
          ]),
        ]
      ),
    ]
  );

const modelRow = (
  model: Model,
  listing: ModelListing,
  highlighted: boolean,
  h: HtmlBuilder<Message>
): Html => {
  const key = listingKey(listing);

  const selected = Option.exists(
    resolvedModel(model),
    (ref) =>
      ref.provider === listing.provider && ref.modelId === listing.modelId
  );

  const favorite = model.settings.favoriteModels.includes(key);

  return h.div(
    [
      h.Key(key),
      h.Role("option"),
      h.AriaSelected(selected),
      h.DataAttribute("slot", "combobox-item"),
      h.DataAttribute("model-key", key),
      ...(selected ? [h.DataAttribute("selected", "")] : []),
      ...(highlighted ? [h.DataAttribute("highlighted", "")] : []),
      ...(listing.available ? [] : [h.DataAttribute("disabled", "")]),
      h.Class(ROW_CLASS),
      h.OnMouseMove(Message.MovedPopoverHighlight({ id: key })),
      h.OnClick(
        Message.PickedModel({
          model: { provider: listing.provider, modelId: listing.modelId },
        })
      ),
    ],
    [
      h.div(
        [
          h.Class("flex min-w-0 flex-1 items-center gap-2"),
          h.DataAttribute("slot", "combobox-item-content"),
        ],
        [
          h.div(
            [h.Class("min-w-0 flex-1 text-left")],
            [
              h.div(
                [h.Class("min-w-0 truncate text-xs font-medium leading-snug")],
                [listing.name]
              ),
              h.div(
                [h.Class("mt-1 flex items-center gap-1.5")],
                [
                  h.span(
                    [
                      h.Class(
                        "truncate text-xs font-normal leading-snug text-muted-foreground/70"
                      ),
                    ],
                    [
                      listing.available
                        ? listing.provider
                        : `${listing.provider} (no key)`,
                    ]
                  ),
                ]
              ),
            ]
          ),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel(
                favorite ? "Remove from favorites" : "Add to favorites"
              ),
              h.AriaPressed(favorite ? "true" : "false"),
              h.Class(STAR_CLASS),
              h.OnClick(Message.ToggledFavoriteModel({ key })),
            ],
            [
              icon(
                h,
                Star,
                "star",
                favorite ? "size-3.5 fill-current" : "size-3.5"
              ),
            ]
          ),
        ]
      ),
    ]
  );
};

const modelPicker = (
  model: Model,
  query: string,
  highlighted: Option.Option<string>,
  h: HtmlBuilder<Message>
): Html => {
  const active = highlightedKey(model, highlighted);
  const groups = modelGroups(model, query);

  return h.div(
    [
      h.DataAttribute("model-picker-content", "true"),
      h.DataAttribute("testid", "composer-model-list"),
      h.Class(
        "relative flex max-h-86.5 w-screen max-w-90 flex-col overflow-hidden bg-muted/40"
      ),
    ],
    [
      searchField(h, query, "Search models...", (key) =>
        pickerKeyMessage(model, key)
      ),
      h.div(
        [
          h.Role("listbox"),
          h.AriaLabel("Models"),
          h.Class("min-h-0 overflow-y-auto px-1 py-1.5"),
        ],
        Option.isNone(model.catalog) ||
          Array.every(groups, (group) => group.models.length === 0)
          ? [
              h.p(
                [h.Class("p-2 text-center text-muted-foreground text-sm")],
                [
                  Option.isNone(model.catalog)
                    ? Option.getOrElse(
                        model.catalogError,
                        () => "Loading models..."
                      )
                    : "No matching model.",
                ]
              ),
            ]
          : groups.map((group) =>
              h.div(
                [
                  h.Key(group.id),
                  h.Role("group"),
                  h.AriaLabel(group.label),
                  h.Class("flex flex-col"),
                ],
                [
                  h.div(
                    [
                      h.Class(
                        "px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs"
                      ),
                    ],
                    [group.label]
                  ),
                  ...group.models.map((listing) =>
                    modelRow(
                      model,
                      listing,
                      Option.contains(active, listingKey(listing)),
                      h
                    )
                  ),
                ]
              )
            )
      ),
    ]
  );
};

const menuPanel = (
  h: HtmlBuilder<Message>,
  label: string,
  rows: ReadonlyArray<Html>
): Html =>
  h.div(
    [
      h.Role("menu"),
      h.AriaLabel(label),
      h.Class(
        "flex min-w-[min(12rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col p-1"
      ),
    ],
    rows
  );

const plainRow = (
  h: HtmlBuilder<Message>,
  key: string,
  onClick: Message,
  content: ReadonlyArray<Html | string>
): Html =>
  h.button(
    [
      h.Key(key),
      h.Type("button"),
      h.Role("menuitem"),
      h.Class(`${MENU_ITEM_CLASS} w-full text-left`),
      h.OnClick(onClick),
    ],
    content
  );

const projectKeyMessage = (
  projects: ReadonlyArray<{ readonly id: ProjectId }>,
  key: string
): Option.Option<Message> => {
  if (key === "Escape") {
    return Option.some(Message.ClosedPopover());
  }

  return key === "Enter"
    ? Option.map(Array.head(projects), (project) =>
        Message.PickedProject({ projectId: project.id })
      )
    : Option.none();
};

const COMBOBOX_INPUT_CLASS =
  "w-full min-w-0 rounded-[inherit] outline-none placeholder:text-placeholder [transition:background-color_5000000s_ease-in-out_0s] h-7.5 px-[calc(--spacing(2.5)-1px)] leading-7.5 sm:h-6.5 sm:leading-6.5";

/** One project row, t3code's combobox item: a folder mark and the title on up to two lines. */
const projectItem = (
  h: HtmlBuilder<Message>,
  key: string,
  onClick: Message,
  title: string,
  mark: Html,
  highlighted: boolean
): Html =>
  h.div(
    [
      h.Key(key),
      h.Role("option"),
      h.AriaSelected(highlighted),
      // Enter picks the first row, so it is the highlighted one, as in t3code.
      ...(highlighted ? [h.DataAttribute("highlighted", "")] : []),
      h.DataAttribute("slot", "combobox-item"),
      h.Class(COMBOBOX_ITEM_CLASS),
      h.OnClick(onClick),
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
          h.span(
            [
              h.AriaHidden(true),
              h.Class(
                "inline-flex items-center justify-center size-4 shrink-0"
              ),
            ],
            [mark]
          ),
          h.span(
            [
              h.DataAttribute("slot", "tooltip-trigger"),
              h.Class("min-w-0 flex-1 text-sm"),
            ],
            [
              h.span(
                [
                  h.Class(
                    "min-w-0 line-clamp-2 whitespace-normal [overflow-wrap:anywhere]"
                  ),
                ],
                [title]
              ),
            ]
          ),
        ]
      ),
    ]
  );

const projectSearch = (
  h: HtmlBuilder<Message>,
  query: string,
  onKey: (key: string) => Option.Option<Message>
): Html =>
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
          icon(
            h,
            Search,
            "search",
            "pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
          ),
          h.div(
            [h.Class("relative w-full text-foreground")],
            [
              h.span(
                [
                  h.DataAttribute("slot", "input-control"),
                  h.Class(
                    "rounded-none bg-transparent text-sm [&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                  ),
                ],
                [
                  h.input([
                    h.Type("text"),
                    h.Role("combobox"),
                    h.AriaExpanded(true),
                    h.Placeholder("Search projects..."),
                    h.AriaLabel("Search projects"),
                    h.Autocomplete("off"),
                    h.Spellcheck(false),
                    h.Autofocus(true),
                    h.DataAttribute("slot", "combobox-input"),
                    h.Value(query),
                    h.Class(COMBOBOX_INPUT_CLASS),
                    h.OnInput((value) =>
                      Message.ChangedPopoverQuery({ query: value })
                    ),
                    h.OnKeyDownPreventDefault((key) => onKey(key)),
                  ]),
                ]
              ),
            ]
          ),
        ]
      ),
    ]
  );

/**
 * The hero's project picker, drawn as t3code's project combobox: a search field over a scrolling
 * list of projects, then "Add project".
 */
const projectPicker = (
  model: Model,
  query: string,
  h: HtmlBuilder<Message>
): Html => {
  const needle = query.trim().toLowerCase();

  const projects = Array.filter(
    pickableProjects(model),
    (project) =>
      needle.length === 0 || project.title.toLowerCase().includes(needle)
  );

  const rows = [
    ...projects.map((project, index) =>
      projectItem(
        h,
        project.id,
        Message.PickedProject({ projectId: project.id }),
        project.title,
        icon(h, Folder, "folder", ""),
        index === 0
      )
    ),
    ...(needle.length === 0
      ? [
          projectItem(
            h,
            "add-project",
            Message.ClickedAddProject(),
            "Add project",
            icon(h, FolderPlus, "folder-plus", ""),
            false
          ),
        ]
      : []),
  ];

  return h.div(
    [
      h.Role("dialog"),
      h.DataAttribute("slot", "combobox-popup"),
      h.Class(COMBOBOX_LIST_CLASS),
    ],
    [
      projectSearch(h, query, (key) => projectKeyMessage(projects, key)),
      h.div([
        h.Role("status"),
        h.DataAttribute("slot", "combobox-empty"),
        h.Class(
          "not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm"
        ),
      ]),
      h.div(
        [
          h.DataAttribute("testid", "hero-project-list"),
          h.Class(
            "relative size-full min-h-0 overflow-hidden rounded-[inherit]"
          ),
        ],
        [
          h.div(
            [
              h.DataAttribute("slot", "scroll-area-viewport"),
              h.Class(
                "h-full max-h-[inherit] overflow-auto overscroll-contain rounded-[inherit] outline-none"
              ),
            ],
            [
              h.div(
                [
                  h.Role("listbox"),
                  h.AriaLabel("Projects"),
                  h.DataAttribute("slot", "combobox-list"),
                  h.Class(
                    "not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1"
                  ),
                ],
                rows
              ),
            ]
          ),
        ]
      ),
    ]
  );
};

const branchPicker = (
  model: Model,
  query: string,
  h: HtmlBuilder<Message>
): Html => {
  const branches = Option.match(model.branches, {
    onNone: () => [],
    onSome: ({ result }) =>
      filterBranches(result.branches, result.current, query),
  });

  return h.div(
    [
      h.DataAttribute("testid", "hero-branch-list"),
      h.Class("flex w-72 max-w-[calc(100vw-2rem)] flex-col"),
    ],
    [
      searchField(h, query, "Search branches...", (key) =>
        key === "Escape" ? Option.some(Message.ClosedPopover()) : Option.none()
      ),
      h.div(
        [
          h.Role("listbox"),
          h.AriaLabel("Branches"),
          h.Class("flex max-h-72 flex-col overflow-y-auto p-1"),
        ],
        branches.length === 0
          ? [
              h.p(
                [h.Class("p-2 text-center text-muted-foreground text-sm")],
                [
                  Option.isNone(model.branches)
                    ? "Loading branches..."
                    : "No matching branch.",
                ]
              ),
            ]
          : branches.map((branch) =>
              plainRow(
                h,
                `${branch.isRemote ? "remote" : "local"}:${branch.name}`,
                Message.PickedBranch({ branch: branch.name }),
                [h.span([h.Class("min-w-0 truncate")], [branch.name])]
              )
            )
      ),
    ]
  );
};

const envModeMenu = (model: Model, h: HtmlBuilder<Message>): Html => {
  const current = activeDraft(model).envMode;

  return menuPanel(
    h,
    "Workspace",
    (["local", "worktree"] as const).map((mode) =>
      plainRow(h, mode, Message.PickedEnvMode({ mode }), [
        h.span([h.Class("flex-1")], [resolveEnvModeLabel(mode)]),
        current === mode
          ? h.span([h.Class("text-muted-foreground text-xs")], ["Current"])
          : h.empty,
      ])
    )
  );
};

/** Where the open popover sits: above the card for a docked composer, below it in the hero. */
export const popoverSide = (model: Model): "top" | "bottom" =>
  isDraftTarget(model) ? "bottom" : "top";

/** The open popover's panel, with a backdrop that closes it, or nothing. */
export const popoverView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.popover, {
    onNone: () => h.empty,
    onSome: (popover) => {
      const content = Popover.match(popover, {
        ModelPicker: ({ highlighted, query }) =>
          modelPicker(model, query, highlighted, h),
        Thinking: () => menuPanel(h, "Thinking", thinkingItems(model, h)),
        RuntimeMode: () => menuPanel(h, "Runtime mode", modeItems(model, h)),
        Overflow: () =>
          menuPanel(h, "More composer controls", overflowItems(model, h)),
        Project: ({ query }) => projectPicker(model, query, h),
        EnvMode: () => envModeMenu(model, h),
        Branch: ({ query }) => branchPicker(model, query, h),
      });

      const side = popoverSide(model);

      const anchored = Popover.match(popover, {
        ModelPicker: () => "left-0",
        Thinking: () => "left-0",
        RuntimeMode: () => "left-0",
        Overflow: () => "left-0",
        Project: () => "left-1/2 -translate-x-1/2",
        EnvMode: () => "left-0",
        Branch: () => "right-0",
      });

      return h.div(
        [h.Class("contents")],
        [
          h.button([
            h.Type("button"),
            h.AriaLabel("Close"),
            h.Tabindex(-1),
            h.Class("fixed inset-0 z-40 cursor-default bg-transparent"),
            h.OnClick(Message.ClosedPopover()),
          ]),
          Predicate.isTagged(popover, "Project")
            ? h.div(
                [
                  h.Role("presentation"),
                  h.DataAttribute("slot", "combobox-positioner"),
                  h.DataAttribute("side", side),
                  // t3code opens it 4 px under the headline's project button, which sits 44 px
                  // above the card (the hero's pb-4, then the "or start without a project" line).
                  h.Class(`absolute z-50 select-none ${anchored} -top-11`),
                ],
                [
                  h.span(
                    [h.Class(`${COMBOBOX_POPUP_CLASS} w-72 overflow-hidden`)],
                    [content]
                  ),
                ]
              )
            : h.div(
                [
                  h.Role("dialog"),
                  h.DataAttribute("slot", "popover-popup"),
                  h.DataAttribute("side", side),
                  h.DataAttribute("testid", `composer-popover-${popover._tag}`),
                  h.Class(
                    `${POPUP_CLASS.replace("relative ", "")} absolute z-50 ${anchored} ${side === "top" ? "bottom-full mb-2" : "top-full mt-2"}`
                  ),
                  h.OnKeyDownPreventDefault((key) =>
                    key === "Escape"
                      ? Option.some(Message.ClosedPopover())
                      : Option.none()
                  ),
                ],
                [
                  h.div(
                    [
                      h.DataAttribute("slot", "popover-viewport"),
                      h.Class("relative size-full overflow-clip"),
                    ],
                    [content]
                  ),
                ]
              ),
        ]
      );
    },
  });
