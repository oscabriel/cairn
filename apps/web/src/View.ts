// The app frame: the sidebar (projects, threads, search, shelves) and the routed page beside it, in
// t3code's sidebar wrapper. The hero and composer serve the inbox and draft pages, and the composer
// docks under an open thread. The judges' data attributes live in the sidebar's shell index.
import { Array, Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import * as Composer from "./composer/View.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import * as Thread from "./page/thread/index.ts";
import { view as pushView } from "./push/View.ts";
import { AppRoute } from "./Route.ts";
import { loadedSettingsView, settingsPlaceholder } from "./SettingsPage.ts";
import { view as parkedView } from "./shell/Parked.ts";
import { sidebarState, view as sidebarView } from "./sidebar/View.ts";
import { CHAT_COLUMN_CLASS, chatHeader } from "./ui/ChatHeader.ts";

const placeholder = (h: HtmlBuilder<Message>, text: string): Html =>
  h.div(
    [
      h.Class(
        "flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm"
      ),
    ],
    [text]
  );

const threadTitle = (model: Model, threadId: string): Option.Option<string> =>
  Option.flatMap(model.shell, (shell) =>
    Option.map(
      Array.findFirst(shell.threads, (thread) => thread.id === threadId),
      (thread) => thread.title
    )
  );

/** The thread's working directory: its worktree, else its project's workspace root. */
const threadWorkspaceRoot = (
  model: Model,
  threadId: string
): Option.Option<string> =>
  Option.flatMap(model.shell, (shell) =>
    Option.flatMap(
      Array.findFirst(shell.threads, (thread) => thread.id === threadId),
      (thread) =>
        Option.orElse(thread.worktreePath, () =>
          Option.map(
            Array.findFirst(
              shell.projects,
              (project) => project.id === thread.projectId
            ),
            (project) => project.workspaceRoot
          )
        )
    )
  );

const threadProjectTitle = (
  model: Model,
  threadId: string
): Option.Option<string> =>
  Option.flatMap(model.shell, (shell) =>
    Option.flatMap(
      Array.findFirst(shell.threads, (thread) => thread.id === threadId),
      (thread) =>
        Option.map(
          Array.findFirst(
            shell.projects,
            (project) => project.id === thread.projectId
          ),
          (project) => project.title
        )
    )
  );

const composer = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: "composer",
    model: model.composer,
    view: Composer.view,
    toParentMessage: (message) => Message.GotComposerMessage({ message }),
  });

const page = (model: Model, h: HtmlBuilder<Message>): Html =>
  AppRoute.match(model.route, {
    Inbox: () => composer(model, h),
    Thread: ({ threadId }) =>
      h.div(
        [
          h.DataAttribute("chat-column-maximized-away", "false"),
          h.DataAttribute("chat-column", "true"),
          h.Class(`relative ${CHAT_COLUMN_CLASS}`),
        ],
        [
          chatHeader(h, {
            project: Option.map(
              threadProjectTitle(model, threadId),
              (title) => ({
                title,
                ariaLabel: `New thread in ${title}`,
                onClick: Option.none(),
              })
            ),
            title: Option.getOrElse(
              threadTitle(model, threadId),
              () => "Thread"
            ),
            controls: [
              h.submodel({
                slotId: "thread-header-controls",
                model: model.thread,
                view: Thread.headerControls,
                toParentMessage: (message) =>
                  Message.GotThreadMessage({ message }),
              }),
            ],
          }),
          h.submodel({
            slotId: "thread-hold",
            model: model.parked,
            view: parkedView,
            toParentMessage: (message) => Message.GotParkedMessage({ message }),
          }),
          // The transcript scrolls itself, so this wrapper must not.
          h.div(
            [h.Class("flex min-h-0 flex-1 flex-col")],
            [
              h.submodel({
                slotId: "thread",
                model: model.thread,
                view: Thread.view,
                viewInputs: {
                  workspaceRoot: threadWorkspaceRoot(model, threadId),
                },
                toParentMessage: (message) =>
                  Message.GotThreadMessage({ message }),
              }),
            ]
          ),
          composer(model, h),
        ]
      ),
    Draft: () => composer(model, h),
    Settings: () =>
      Option.match(loadedSettingsView(), {
        onNone: () => settingsPlaceholder(h, model.settingsPage === "failed"),
        onSome: (settingsView) =>
          h.submodel({
            slotId: "settings",
            model: model.settings,
            view: settingsView,
            viewInputs: {
              notifications: () =>
                h.submodel({
                  slotId: "push-toggle",
                  model: model.push,
                  view: pushView,
                  toParentMessage: (message) =>
                    Message.GotPushMessage({ message }),
                }),
            },
            toParentMessage: (message) =>
              Message.GotSettingsMessage({ message }),
          }),
      }),
    NotFound: ({ path }) => placeholder(h, `Nothing lives at ${path}.`),
  });

const noticeBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.notice, {
    onNone: () => h.empty,
    onSome: (notice) =>
      h.div(
        [
          h.DataAttribute("testid", "notice"),
          h.Role("status"),
          h.Class("border-b px-4 py-2 text-sm"),
        ],
        [notice]
      ),
  });

/** The app. */
export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Cairn",
  body: h.div(
    [
      // Foldkit replaces the mount node with this element unless the two match, so it keeps
      // index.html's id and with it the #root rules in styles.css (the safe-area top inset).
      h.Id("root"),
      h.DataAttribute("slot", "sidebar-wrapper"),
      h.DataAttribute("sidebar-state", sidebarState(model.sidebar)),
      h.Class(
        "group/sidebar-wrapper flex min-h-svh w-full max-sm:[--workspace-titlebar-control-size:--spacing(8)] h-dvh! min-h-0!"
      ),
    ],
    [
      h.submodel({
        slotId: "sidebar",
        model: model.sidebar,
        view: sidebarView,
        toParentMessage: (message) => Message.GotSidebarMessage({ message }),
      }),
      h.main(
        [
          h.DataAttribute("slot", "sidebar-inset"),
          h.Class(
            "relative flex min-w-0 w-full flex-1 flex-col bg-background text-foreground surface-grain h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
          ),
        ],
        [noticeBar(model, h), page(model, h)]
      ),
    ]
  ),
});
