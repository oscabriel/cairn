// The `next` shell's views (plan look track L6), each a Submodel view over the shell's Model: the
// project rail with the selected project's list (a column on a desktop, a sheet on a phone), the
// chat header's lead and actions, the refresh confirm, the add-project picker, and the scratch
// overlay's scrim, head and foot. `Layout.ts` places them around the page's own parts, which keep their own Messages; the
// look catalogue draws them over a fixture.

import { Option, Predicate, Record } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import "./shell.css";
import { addProjectPicker } from "./AddProject.ts";
import {
  managedMetaOf,
  managedThreadsFor,
  openThreadOf,
  projectMarkOf,
  projectOfThread,
  projectThreadAgeOf,
  projectThreadFor,
  railProjectsOf,
  requestsOf,
  rowStatusOf,
  selectedProjectOf,
  threadRoleOf,
} from "./Derived.ts";
import { headerActions, headerLead } from "./Header.ts";
import type { HeaderContent } from "./Header.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import { projectFaviconUrl, rail } from "./Rail.ts";
import type { RailBubble, RailDirection } from "./Rail.ts";
import { refreshConfirm } from "./Refresh.ts";
import { scratchFoot, scratchHead, scratchScrim } from "./Scratch.ts";
import type { Placement } from "./Scratch.ts";
import { sidebarList } from "./Sidebar.ts";
import type { SidebarContent } from "./Sidebar.ts";

type H = HtmlBuilder<Message>;

/** The rail's bubbles, the selected one ringed. */
export const railBubblesOf = (model: Model): ReadonlyArray<RailBubble> => {
  const requests = requestsOf(model);
  const selected = selectedProjectOf(model);

  return railProjectsOf(model).map((project) => ({
    project,
    isSelected: Option.exists(selected, (each) => each.id === project.id),
    mark: projectMarkOf(model, project, requests),
    favicon: Record.get(model.favicons, project.id),
    faviconUrl: projectFaviconUrl(project.id),
  }));
};

/** Which foot button the route is: the usage page, the settings page, or neither. */
const footCurrentOf = (model: Model): SidebarContent["current"] => {
  if (Predicate.isTagged(model.context.route, "Usage")) {
    return "usage";
  }

  return Predicate.isTagged(model.context.route, "Settings")
    ? "settings"
    : "none";
};

/** What the sidebar list shows for the selected project. */
export const sidebarContentOf = (model: Model): SidebarContent => {
  const requests = requestsOf(model);
  const { nowMs } = model.context;
  const project = selectedProjectOf(model);
  const openId = Option.map(openThreadOf(model), (thread) => thread.id);

  const top = Option.flatMap(project, (each) => projectThreadFor(model, each));

  return {
    project,
    projectThread: Option.map(top, (thread) => ({
      thread,
      row: rowStatusOf(thread, requests, nowMs),
      age: projectThreadAgeOf(thread, nowMs),
      isOpen: Option.contains(openId, thread.id),
    })),
    managed: Option.match(top, {
      onNone: () => [],
      onSome: (thread) =>
        managedThreadsFor(model, thread).map((managed) => {
          const row = rowStatusOf(managed, requests, nowMs);

          return {
            thread: managed,
            row,
            meta: managedMetaOf(managed, row, nowMs),
            isOpen: Option.contains(openId, managed.id),
          };
        }),
    }),
    current: footCurrentOf(model),
  };
};

const ROLE_WORDS = {
  "project-thread": "project thread",
  scratch: "scratch thread",
  thread: "thread",
} as const;

const PAGE_TITLES = {
  Hero: "",
  Thread: "Thread",
  Draft: "New thread",
  Settings: "Settings",
  Usage: "Usage",
  NotFound: "Not found",
} as const;

/** What the chat header says on the open page. */
export const headerContentOf = (model: Model): HeaderContent => {
  const scratchHint = model.context.isMac ? "⌘J" : "Ctrl+J";
  const { route } = model.context;

  const plain = (title: string): HeaderContent => ({
    title,
    role: Option.none(),
    status: Option.none(),
    canRefresh: false,
    scratchHint,
  });

  if (Predicate.isTagged(route, "Hero")) {
    return plain(
      Option.getOrElse(
        Option.map(selectedProjectOf(model), (project) => project.title),
        () => "Cairn"
      )
    );
  }

  if (!Predicate.isTagged(route, "Thread")) {
    return plain(PAGE_TITLES[route._tag]);
  }

  return Option.match(openThreadOf(model), {
    onNone: () => plain(PAGE_TITLES.Thread),
    onSome: (thread) => {
      const role = threadRoleOf(model, thread);
      const project = projectOfThread(model, thread);
      const row = rowStatusOf(thread, requestsOf(model), model.context.nowMs);
      const projectTitle = Option.map(project, (each) => each.title);

      return {
        title:
          role === "project-thread"
            ? Option.getOrElse(projectTitle, () => thread.title)
            : thread.title,
        role: Option.some(
          role === "managed"
            ? Option.match(projectTitle, {
                onNone: () => "managed thread",
                onSome: (title) => `managed by ${title}'s project thread`,
              })
            : ROLE_WORDS[role]
        ),
        status: Option.some(row),
        canRefresh: role === "project-thread",
        scratchHint,
      };
    },
  });
};

/** The scratch shortcut's keys as its hint shows them. */
export const scratchKeysOf = (model: Model): ReadonlyArray<string> =>
  model.context.isMac ? ["⌘", "J"] : ["Ctrl", "J"];

/** The rail and the list together, in a column (desktop) or the sheet (phone). */
export const navigation = (
  h: H,
  model: Model,
  direction: RailDirection
): ReadonlyArray<Html> => [
  rail(h, direction, railBubblesOf(model)),
  sidebarList(h, sidebarContentOf(model)),
];

/**
 * The desktop's left column: the rail and the selected project's list, hidden on a phone. Below
 * `xl` it is as wide as the classic sidebar (16rem), so the page beside it, and with it the
 * composer's footer, keeps the widths the parity judges hold; from `xl` the list takes round 1's
 * width.
 */
export const columnView = Submodel.defineView<Model, Message>((model, h) =>
  h.aside(
    [
      h.DataAttribute("testid", "shell-column"),
      h.AriaLabel("Projects and threads"),
      h.Class(
        "flex w-64 shrink-0 border-e border-stroke-1 max-md:hidden xl:w-88"
      ),
    ],
    navigation(h, model, "column")
  )
);

/** The phone's sidebar sheet, while it is open: the rail across its top, then the list. */
export const sheetView = Submodel.defineView<Model, Message>((model, h) =>
  model.isSheetOpen
    ? h.div(
        [
          h.DataAttribute("testid", "sidebar-sheet"),
          h.Class("contents md:hidden"),
        ],
        [
          h.div([
            h.AriaHidden(true),
            h.OnClick(Message.ClickedCloseSheet()),
            h.Class("fixed inset-0 z-(--layer-scrim) bg-scrim md:hidden"),
          ]),
          h.div(
            [
              h.Role("dialog"),
              h.AriaLabel("Projects and threads"),
              h.Class(
                "fixed inset-y-0 start-0 z-(--layer-sheet) flex w-[min(22rem,88vw)] flex-col border-e border-stroke-1 bg-surface-sidebar pt-[env(safe-area-inset-top)] shadow-(--elevation-3) md:hidden"
              ),
            ],
            navigation(h, model, "row")
          ),
        ]
      )
    : h.empty
);

/** The chat header's lead. */
export const headerLeadView = Submodel.defineView<Model, Message>((model, h) =>
  headerLead(h, headerContentOf(model))
);

/** The chat header's actions. */
export const headerActionsView = Submodel.defineView<Model, Message>(
  (model, h) => headerActions(h, headerContentOf(model))
);

/** Where an overlay view sits. */
export interface PlacementInput {
  readonly placement: Placement;
}

/** The refresh confirm, while a refresh is being asked. */
export const refreshView = Submodel.defineView<Model, Message, PlacementInput>(
  (model, { placement }, h) =>
    refreshConfirm(
      h,
      model.refresh,
      Option.getOrElse(
        Option.map(selectedProjectOf(model), (project) => project.title),
        () => "this project"
      ),
      placement
    )
);

/** The add-project picker, while it is open. */
export const addProjectView = Submodel.defineView<
  Model,
  Message,
  PlacementInput
>((model, { placement }, h) =>
  addProjectPicker(h, model.addProject, placement)
);

/** The scratch overlay's scrim. */
export const scratchScrimView = Submodel.defineView<
  Model,
  Message,
  PlacementInput
>((_model, { placement }, h) => scratchScrim(h, placement));

/** The scratch overlay's head. */
export const scratchHeadView = Submodel.defineView<Model, Message>((model, h) =>
  scratchHead(h, model.scratch, scratchKeysOf(model))
);

/** The scratch overlay's foot. */
export const scratchFootView = Submodel.defineView<Model, Message>((model, h) =>
  scratchFoot(h, model.scratch, model.failure)
);
