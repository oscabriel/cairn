// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ComposerCommandMenu.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the drawer attached above the composer card with
// one row per suggestion (label, then description), its class strings, the empty and loading
// lines, and the listbox labels. Changed: Cairn's suggestions are its `/model` command, pi skills
// (`/skill:<name>` and `$<name>`), the brain's file search and, for `/model <query>`, the models
// themselves; there are no pull requests, threads or provider commands. The rows are computed here
// from the Model, so update and view read the same list.
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
import { resolveComposerMenuActiveItemId } from "@cairn/client-logic/ComposerLogic";
import type {
  ComposerTrigger,
  ComposerTriggerKind,
} from "@cairn/client-logic/ComposerTrigger";
import { serializeComposerFileLink } from "@cairn/client-logic/ComposerTrigger";
import { modelPickerModelKey } from "@cairn/client-logic/ModelSearch";
import {
  searchSkills,
  searchSlashItems,
  skillSlashItem,
  SlashItem,
} from "@cairn/client-logic/SlashCommandSearch";
import { ModelRef } from "@cairn/protocol/Models";
import { Array, Option, Schema } from "effect";
import type { Html, HtmlBuilder } from "foldkit/html";

import { targetProject } from "./Drafts.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { modelGroups } from "./Models.ts";

/**
 * What picking a suggestion does: replace the trigger's text with `text`, switch the model and
 * remove the `/model` text, or turn the `/` into `/model ` so the model list takes over.
 */
export const MenuAction = Schema.TaggedUnion({
  Insert: { text: Schema.String },
  ChooseModel: { model: ModelRef },
  OpenModels: {},
});

export type MenuAction = typeof MenuAction.Type;

const { ChooseModel, Insert, OpenModels } = MenuAction.cases;

/** One suggestion row. */
export interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly action: MenuAction;
}

/** The open menu's rows, and whether more are on their way. */
export interface MenuContents {
  readonly trigger: ComposerTrigger;
  readonly items: ReadonlyArray<MenuItem>;
  readonly loading: boolean;
  /** Why the list could not be loaded, shown in place of the empty text. */
  readonly error: Option.Option<string>;
  readonly activeId: Option.Option<string>;
}

/** The commands Cairn offers under `/`. */
const commands: ReadonlyArray<SlashItem> = [
  SlashItem.Command({
    id: "slash:model",
    command: "model",
    label: "/model",
    description: "Switch response model for this thread",
  }),
];

const skillsOf = (model: Model) =>
  Option.match(model.skills, {
    onNone: () => [],
    onSome: (skills) => skills.list,
  });

/** True while the target project's skills have not arrived. */
export const skillsPending = (model: Model): boolean =>
  Option.exists(
    targetProject(model),
    (project) =>
      !Option.exists(model.skills, (skills) => skills.projectId === project.id)
  );

const slashItems = (model: Model, query: string): ReadonlyArray<MenuItem> =>
  searchSlashItems(
    [...commands, ...skillsOf(model).map(skillSlashItem)],
    query
  ).map((item) =>
    SlashItem.$match(item, {
      Command: ({ description, id, label }) => ({
        id,
        label,
        description,
        action: OpenModels.make({}),
      }),
      Skill: ({ description, id, label, skill }) => ({
        id,
        label,
        description,
        action: Insert.make({ text: `/skill:${skill.name} ` }),
      }),
    })
  );

const skillItems = (model: Model, query: string): ReadonlyArray<MenuItem> =>
  searchSkills(skillsOf(model), query).map((skill) => ({
    id: `skill:${skill.name}`,
    label: `$${skill.name}`,
    description: skill.description,
    action: Insert.make({ text: `$${skill.name} ` }),
  }));

const pathItems = (model: Model, query: string): ReadonlyArray<MenuItem> => {
  const current =
    model.pathSearch.query === query.trim() &&
    Option.isNone(model.pathSearch.pending) &&
    Option.exists(targetProject(model), (project) =>
      Option.contains(model.pathSearch.projectId, project.id)
    );

  return current
    ? model.pathSearch.entries.map((entry) => ({
        id: `path:${entry.path}`,
        label: entry.path.split("/").at(-1) ?? entry.path,
        description: entry.path,
        action: Insert.make({
          text: `${serializeComposerFileLink(entry.path)} `,
        }),
      }))
    : [];
};

const modelItems = (model: Model, query: string): ReadonlyArray<MenuItem> =>
  Array.flatMap(modelGroups(model, query), (group) => group.models).map(
    (listing) => ({
      id: modelPickerModelKey(listing.provider, listing.modelId),
      label: listing.name,
      description: listing.provider,
      action: ChooseModel.make({
        model: { provider: listing.provider, modelId: listing.modelId },
      }),
    })
  );

const ITEMS: Readonly<
  Record<
    ComposerTriggerKind,
    (model: Model, query: string) => ReadonlyArray<MenuItem>
  >
> = {
  path: (model, query) => pathItems(model, query),
  skill: (model, query) => skillItems(model, query),
  "slash-model": (model, query) => modelItems(model, query),
  "slash-command": (model, query) => slashItems(model, query),
};

const itemsFor = (
  model: Model,
  trigger: ComposerTrigger
): ReadonlyArray<MenuItem> => ITEMS[trigger.kind](model, trigger.query);

/** The search key a highlight belongs to: the trigger's kind and query. */
export const menuSearchKey = (trigger: ComposerTrigger): string =>
  `${trigger.kind}:${trigger.query}`;

/** The open menu's contents, or none when no menu is open. */
export const menuContents = (model: Model): Option.Option<MenuContents> =>
  Option.map(model.triggerMenu, (menu) => {
    const items = itemsFor(model, menu.trigger);

    return {
      trigger: menu.trigger,
      items,
      loading:
        menu.trigger.kind === "path"
          ? Option.isSome(model.pathSearch.pending)
          : menu.trigger.kind !== "slash-model" && skillsPending(model),
      error:
        menu.trigger.kind === "path" &&
        Option.isNone(model.pathSearch.pending) &&
        model.pathSearch.query === menu.trigger.query.trim()
          ? model.pathSearch.error
          : Option.none(),
      activeId: resolveComposerMenuActiveItemId(
        items.map((item) => item.id),
        menu.highlighted,
        menuSearchKey(menu.trigger),
        menu.highlightedKey
      ),
    };
  });

/** The id of the menu's listbox, for the editor's `aria-controls`. */
export const MENU_LIST_ID = "composer-suggestions";

/** The DOM id of one suggestion row. */
export const menuOptionId = (itemId: string): string =>
  `${MENU_LIST_ID}-${encodeURIComponent(itemId)}`;

const LISTBOX_LABEL: Readonly<Record<ComposerTriggerKind, string>> = {
  path: "Files and folders",
  "slash-command": "Commands",
  "slash-model": "Models",
  skill: "Skills",
};

const EMPTY_TEXT: Readonly<Record<ComposerTriggerKind, string>> = {
  path: "No matching files or folders.",
  skill: "No skills found. Try / to browse commands.",
  "slash-model": "No matching model.",
  "slash-command": "No matching command.",
};

const emptyText = (contents: MenuContents): string => {
  if (contents.loading) {
    return contents.trigger.kind === "path"
      ? "Searching workspace files..."
      : "Searching workspace skills...";
  }

  return Option.getOrElse(
    contents.error,
    () => EMPTY_TEXT[contents.trigger.kind]
  );
};

const DRAWER_CLASS =
  "[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--card))] dark:[--chat-composer-attached-surface:var(--chat-composer-glass-surface,var(--surface-raised))] relative isolate border-0 bg-transparent shadow-none [--chat-composer-attached-tint:transparent] [--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--contrast-foreground)_8%,transparent))] dark:[--chat-composer-attached-outline:var(--chat-composer-outline,color-mix(in_srgb,var(--color-white)_5%,transparent))] [--chat-composer-attachment-overlap:calc(1rem+1px)] before:rounded-t-2xl before:mask-t-from-transparent before:mask-t-from-4 before:mask-t-to-black before:mask-t-to-4 before:pointer-events-none before:absolute before:inset-0 before:-z-1 before:border before:border-(--chat-composer-attached-outline) before:bg-(--chat-composer-attached-surface)/(--glass-opacity) before:bg-linear-to-b before:from-(--chat-composer-attached-tint) before:to-(--chat-composer-attached-tint) before:backdrop-blur-(--glass-blur) before:backdrop-saturate-(--glass-saturation) before:shadow-composer dark:before:shadow-composer-dark dark:supports-[(backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px))]:before:bg-composer-seam-above not-supports-[((backdrop-filter:blur(1px))_or_(-webkit-backdrop-filter:blur(1px)))]:before:bg-(--chat-composer-attached-surface) flex min-h-0 w-full flex-col overflow-hidden pb-(--chat-composer-attachment-overlap) **:data-[slot=command-item]:rounded-lg";

/**
 * Where t3code's portaled drawer layer sits: above the card, inset like the banner drawers, its
 * bottom tucked 1rem + 1px under the card's top edge.
 */
const DRAWER_LAYER_CLASS =
  "pointer-events-auto absolute inset-x-(--chat-composer-drawer-inset) bottom-[calc(100%-1rem-1px)] z-40 flex flex-col";

const ITEM_CLASS =
  "flex min-h-8 select-none items-center gap-2 rounded-sm px-2 text-base outline-none data-disabled:pointer-events-none data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='text-'])]:text-muted-foreground py-1.5 cursor-pointer hover:bg-transparent hover:text-inherit";

const itemRow = (
  item: MenuItem,
  isActive: boolean,
  h: HtmlBuilder<Message>
): Html =>
  h.div(
    [
      h.Key(item.id),
      h.Id(menuOptionId(item.id)),
      h.Role("option"),
      h.AriaSelected(isActive),
      h.DataAttribute("slot", "command-item"),
      h.DataAttribute("composer-item-id", item.id),
      ...(isActive ? [h.DataAttribute("active", "true")] : []),
      h.Class(
        isActive
          ? `${ITEM_CLASS} bg-accent! text-accent-foreground!`
          : ITEM_CLASS
      ),
      h.OnMouseMove(Message.HighlightedMenuItem({ id: item.id })),
      h.OnClick(Message.PickedMenuItem({ id: item.id })),
    ],
    [
      h.span(
        [h.Class("flex min-w-0 flex-1 items-center gap-2")],
        [
          h.span(
            [
              h.Class(
                "min-w-0 max-w-[45%] shrink-0 truncate font-sans text-xs font-medium"
              ),
            ],
            [item.label]
          ),
          h.span(
            [
              h.Class(
                "min-w-0 flex-1 truncate text-left text-secondary-label text-xs"
              ),
            ],
            [item.description]
          ),
        ]
      ),
    ]
  );

/** The open menu's list, or what it says when nothing matches. */
const menuBody = (contents: MenuContents, h: HtmlBuilder<Message>): Html =>
  contents.items.length > 0
    ? h.div(
        [
          h.Id(MENU_LIST_ID),
          h.Role("listbox"),
          h.AriaLabel(LISTBOX_LABEL[contents.trigger.kind]),
          h.DataAttribute("slot", "command-list"),
          h.Class(
            "not-empty:scroll-py-2 not-empty:p-2 max-h-72 min-h-0 overflow-y-auto scroll-pb-6"
          ),
        ],
        [
          h.div(
            [h.Role("group"), h.DataAttribute("slot", "command-group")],
            contents.items.map((item) =>
              itemRow(item, Option.contains(contents.activeId, item.id), h)
            )
          ),
        ]
      )
    : h.div(
        [h.Class("px-5 pt-3.5 pb-7")],
        [h.p([h.Class("text-secondary-label text-xs")], [emptyText(contents)])]
      );

/** The drawer above the composer card while a `/`, `@` or `$` menu is open. */
export const triggerMenuView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(menuContents(model), {
    onNone: () => h.empty,
    onSome: (contents) =>
      h.div(
        [
          h.DataAttribute("composer-drawer-layer", "true"),
          h.Class(DRAWER_LAYER_CLASS),
        ],
        [
          h.div(
            [
              // t3code portals this drawer out of the composer, so the shell's
              // `has-[data-composer-banner-surface=attached]` styles never see it; here it stays
              // inside the shell, so its value is not `attached`.
              h.DataAttribute("composer-banner-surface", "floating"),
              h.DataAttribute("composer-command-drawer", "true"),
              h.Class(DRAWER_CLASS),
            ],
            [
              h.div(
                [
                  h.DataAttribute("testid", "composer-menu"),
                  h.DataAttribute("trigger", contents.trigger.kind),
                  h.Class("flex min-h-0 flex-col"),
                ],
                [menuBody(contents, h)]
              ),
            ]
          ),
        ]
      ),
  });
