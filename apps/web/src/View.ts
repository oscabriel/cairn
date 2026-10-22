// The app frame: the sidebar (projects, threads, search, shelves) and the routed page beside it, in
// t3code's sidebar wrapper. The hero and composer serve the inbox and draft pages, and the composer
// docks under an open thread. The judges' data attributes live in the sidebar's shell index.
import { Array, Option } from "effect";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import * as Composer from "./composer/View.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import * as Thread from "./page/thread/index.ts";
import { AppRoute } from "./Route.ts";
import { view as sidebarView } from "./sidebar/View.ts";

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
        [h.Class("relative flex min-h-0 flex-1 flex-col")],
        [
          // The transcript scrolls itself, so this wrapper must not.
          h.div(
            [h.Class("flex min-h-0 flex-1 flex-col")],
            [
              h.submodel({
                slotId: "thread",
                model: model.thread,
                view: Thread.view,
                viewInputs: {
                  title: threadTitle(model, threadId),
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
      h.section(
        [
          h.DataAttribute("testid", "settings-page"),
          h.Class("mx-auto w-full max-w-2xl p-6"),
        ],
        [h.h1([h.Class("font-medium text-lg")], ["Settings"])]
      ),
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
      h.DataAttribute("slot", "sidebar-wrapper"),
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
          h.Class(
            "flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
          ),
        ],
        [noticeBar(model, h), page(model, h)]
      ),
    ]
  ),
});
