// Ported from github.com/pingdotgg/t3code, apps/web/src/components/chat/ComposerCommandMenu.tsx at
// fe27e8e3dc12dcbb108e9a28fd9b8cb65f34ae92. Kept: the drawer attached above the composer card with
// one row per suggestion (label, then description), its class strings, the empty and loading
// lines, and the listbox labels. Changed: Cairn's suggestions are its `/model` command, pi skills
// (`/skill:<name>` and `$<name>`), the brain's file search and, for `/model <query>`, the models
// themselves; there are no pull requests, threads or provider commands. The rows are computed here
// from the Model, so update and view read the same list; the composer draws the drawer
// (`composer/TriggerMenuView.ts`), since the classic one went with the classic views (W-6).
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

import { targetProject } from "./Drafts.ts";
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

/** The path menu's text when the draft has no project whose files it could search. */
const NO_PROJECT_TEXT = "Choose a project to search its files.";

/**
 * Why the path menu lists nothing: no project to search, or the failure of the answered search.
 * Other menus have none.
 */
const menuError = (
  model: Model,
  trigger: ComposerTrigger
): Option.Option<string> => {
  if (trigger.kind !== "path") {
    return Option.none();
  }

  if (Option.isNone(targetProject(model))) {
    return Option.some(NO_PROJECT_TEXT);
  }

  return Option.isNone(model.pathSearch.pending) &&
    model.pathSearch.query === trigger.query.trim()
    ? model.pathSearch.error
    : Option.none();
};

/** The open menu's contents, or none when no menu is open. */
export const menuContents = (model: Model): Option.Option<MenuContents> =>
  Option.map(model.triggerMenu, (menu) => {
    const items = itemsFor(model, menu.trigger);

    return {
      trigger: menu.trigger,
      items,
      loading:
        menu.trigger.kind === "path"
          ? Option.isSome(model.pathSearch.pending) &&
            Option.isSome(targetProject(model))
          : menu.trigger.kind !== "slash-model" && skillsPending(model),
      error: menuError(model, menu.trigger),
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
