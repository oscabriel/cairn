// The `next` shell's views (plan look track L6), each a Submodel view over the shell's Model: the
// project rail with the selected project's list (a column on a desktop, a sheet on a phone), the
// chat header's lead and actions, the refresh confirm, the add-project picker, the rename and remove
// dialog, the read-only bar under an earlier project thread, and the scratch overlay's scrim, head
// and foot. `Layout.ts` places them around the page's own parts, which keep their own Messages; the
// look catalogue draws them over a fixture.

import { managedGroupsOf } from "@cairn/client-logic/Sidebar";
import { lineageWindow } from "@cairn/client-logic/ThreadLineage";
import type { LineageWindow } from "@cairn/client-logic/ThreadLineage";
import { formatSidebarAge } from "@cairn/client-logic/Time";
import { Array, Option, Predicate, Record } from "effect";
import { Submodel } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";

import { classNames } from "../../ui/ClassNames.ts";
import { chunkModule } from "../page/Chunks.ts";
import { buttonDefaults, button } from "../ui/Button.ts";
import { TYPE } from "../ui/Classes.ts";
import {
  managedMetaOf,
  managedThreadsFor,
  openEarlierThreadOf,
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
import type { ManageNames } from "./ManageDialog.ts";
import { Message } from "./Message.ts";
import { ManageAction, MenuTarget } from "./Model.ts";
import type { Model } from "./Model.ts";
import { projectFaviconUrl, rail } from "./Rail.ts";
import type { RailBubble, RailDirection } from "./Rail.ts";
import { scratchFoot, scratchHead, scratchScrim } from "./Scratch.ts";
import type { Placement } from "./Scratch.ts";
import { sidebarList } from "./Sidebar.ts";
import type {
  ManagedContent,
  ManagedRow,
  PreviousContent,
  SidebarContent,
} from "./Sidebar.ts";

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

/** Whether the open menu is `target`'s. */
const isMenuOpen = (model: Model, target: MenuTarget): boolean =>
  Option.exists(model.menu, (open) =>
    MenuTarget.match(open, {
      Project: ({ projectId }) =>
        Predicate.isTagged(target, "Project") && target.projectId === projectId,
      Thread: ({ threadId }) =>
        Predicate.isTagged(target, "Thread") && target.threadId === threadId,
    })
  );

/**
 * The "Previous" fold for the selected project: its earlier project threads once read, none before
 * that, and none while it has none (unless the read failed, which the fold says).
 */
const previousContentOf = (
  model: Model,
  projectId: Option.Option<string>
): Option.Option<PreviousContent> => {
  const { previous } = model;

  if (
    !Option.isSome(projectId) ||
    !Option.contains(previous.projectId, projectId.value)
  ) {
    return Option.none();
  }

  const routed = Predicate.isTagged(model.context.route, "Thread")
    ? Option.some(model.context.route.threadId)
    : Option.none();

  const rows = Option.match(previous.rows, {
    onNone: () => [],
    onSome: (read) => read.threads,
  });

  if (rows.length === 0 && Option.isNone(previous.failure)) {
    return Option.none();
  }

  return Option.some({
    isOpen: previous.isOpen,
    rows: rows.map((thread) => ({
      thread,
      age: formatSidebarAge(
        Option.getOrElse(thread.archivedAt, () => thread.updatedAt),
        model.context.nowMs
      ),
      isOpen: Option.contains(routed, thread.id),
    })),
    hasMore: Option.exists(previous.rows, (read) => Option.isSome(read.next)),
    isLoading: previous.isLoading,
    failure: previous.failure,
  });
};

/**
 * A group's window that keeps the open thread's row on screen: past the window, it follows the
 * shown rows, one fewer hidden.
 */
const windowKeepingOpen = (
  rows: ReadonlyArray<ManagedRow>,
  shown: number
): LineageWindow<ManagedRow> => {
  const window = lineageWindow(rows, shown);

  const open = rows
    .slice(window.visibleRows.length)
    .find((each) => each.isOpen);

  return open === undefined
    ? window
    : {
        visibleRows: [...window.visibleRows, open],
        hiddenCount: window.hiddenCount - 1,
      };
};

/**
 * The managed rows (newest first) in the work panel's shape (U-9): asking and live rows first, the
 * resting ones folded, each group in its window. The open thread's row always shows: past its
 * group's window it follows the shown rows, and in the closed fold it shows under the fold's header.
 */
const managedContentOf = (
  model: Model,
  rows: ReadonlyArray<ManagedRow>
): ManagedContent => {
  const groups = managedGroupsOf(rows, (each) => each.row.category);
  const list = model.managedList;

  return {
    count: rows.length,
    live: windowKeepingOpen(groups.live, list.shownLive),
    resting: windowKeepingOpen(groups.resting, list.shownResting),
    restingCount: groups.resting.length,
    isRestingOpen: list.isRestingOpen,
    openResting: list.isRestingOpen
      ? Option.none()
      : Option.fromUndefinedOr(groups.resting.find((each) => each.isOpen)),
  };
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
    managed: managedContentOf(
      model,
      Option.match(top, {
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
      })
    ),
    previous: previousContentOf(
      model,
      Option.map(project, (each) => each.id)
    ),
    isProjectMenuOpen: Option.exists(project, (each) =>
      isMenuOpen(model, MenuTarget.Project({ projectId: each.id }))
    ),
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
    menu: Option.none(),
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
    onNone: () =>
      Option.match(openEarlierThreadOf(model), {
        onNone: () => plain(PAGE_TITLES.Thread),
        onSome: (thread) => ({
          ...plain(thread.title),
          role: Option.some("earlier project thread"),
        }),
      }),
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
        // The project thread's header and row name its project, not the thread, so a rename of it
        // would change nothing on screen: it has no thread menu.
        menu:
          role === "project-thread"
            ? Option.none()
            : Option.some({
                threadId: thread.id,
                isOpen: isMenuOpen(
                  model,
                  MenuTarget.Thread({ threadId: thread.id })
                ),
              }),
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
  sidebarList(h, sidebarContentOf(model), `-${direction}`),
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

/** The refresh confirm, while a refresh is being asked and its chunk is in. */
export const refreshView = Submodel.defineView<Model, Message, PlacementInput>(
  (model, { placement }, h) =>
    Option.match(chunkModule("refresh"), {
      onNone: () => h.empty,
      onSome: ({ refreshConfirm }) =>
        refreshConfirm(
          h,
          model.refresh,
          Option.getOrElse(
            Option.map(selectedProjectOf(model), (project) => project.title),
            () => "this project"
          ),
          placement
        ),
    })
);

/** The add-project picker, while it is open and its chunk is in (`next/page/Chunks.ts`). */
export const addProjectView = Submodel.defineView<
  Model,
  Message,
  PlacementInput
>((model, { placement }, h) =>
  Option.match(chunkModule("addProject"), {
    onNone: () => h.empty,
    onSome: ({ addProjectPicker }) =>
      addProjectPicker(h, model.addProject, placement),
  })
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

/** A project's name and folder, for the dialog. */
const projectNames = (model: Model, projectId: string): ManageNames =>
  Option.match(
    Array.findFirst(
      railProjectsOf(model),
      (project) => project.id === projectId
    ),
    {
      onNone: () => ({ name: "this project", folder: "its folder" }),
      onSome: (project) => ({
        name: project.title,
        folder: project.workspaceRoot,
      }),
    }
  );

/** The names the rename or remove dialog shows for its target. */
const manageNamesOf = (model: Model): ManageNames =>
  Option.match(model.manage, {
    onNone: () => ({ name: "", folder: "" }),
    onSome: ({ action }) =>
      ManageAction.match(action, {
        RenameProject: ({ projectId }) => projectNames(model, projectId),
        RemoveProject: ({ projectId }) => projectNames(model, projectId),
        RenameThread: () => ({ name: "", folder: "" }),
      }),
  });

/** The rename or remove dialog, while a menu item opened one and its chunk is in. */
export const manageView = Submodel.defineView<Model, Message, PlacementInput>(
  (model, { placement }, h) =>
    Option.match(chunkModule("manageDialog"), {
      onNone: () => h.empty,
      onSome: ({ manageDialog }) =>
        manageDialog(h, model.manage, manageNamesOf(model), placement),
    })
);

/** True when the route shows an earlier project thread: its page is read only (ADR 0048). */
export const isEarlierThreadOpen = (model: Model): boolean =>
  Option.isSome(openEarlierThreadOf(model));

/**
 * In place of the composer under an earlier project thread: what it is, and the way to its
 * project's project thread. Only a refresh makes a project thread, so this one is not unarchived.
 */
export const earlierLaneView = Submodel.defineView<Model, Message>((model, h) =>
  Option.match(openEarlierThreadOf(model), {
    onNone: () => h.empty,
    onSome: (thread) =>
      h.div(
        [
          h.DataAttribute("testid", "earlier-thread-lane"),
          h.Role("status"),
          h.Class(
            "chat-composer-lane w-full shrink-0 px-(--space-2) pt-(--space-2) pb-[calc(env(safe-area-inset-bottom)+var(--space-3))] sm:px-(--space-5)"
          ),
        ],
        [
          h.div(
            [
              h.Class(
                "mx-auto flex w-full max-w-(--chat-content-max-width) flex-wrap items-center gap-(--space-3) rounded-(--radius-large) border border-stroke-2 bg-surface-raised px-(--space-4) py-(--space-3)"
              ),
            ],
            [
              h.p(
                [h.Class(classNames("min-w-0 flex-1 text-ink-2", TYPE.ui))],
                [
                  "An earlier project thread, kept to read. A refresh replaced it, so new messages go to the project thread.",
                ]
              ),
              button(
                h,
                {
                  ...buttonDefaults<Message>(),
                  size: "small",
                  onClick: Option.some(
                    Message.ClickedOpenProjectThread({
                      projectId: thread.projectId,
                    })
                  ),
                  attributes: [
                    h.DataAttribute("testid", "earlier-thread-open-project"),
                  ],
                },
                ["Open the project thread"]
              ),
            ]
          ),
        ]
      ),
  })
);
