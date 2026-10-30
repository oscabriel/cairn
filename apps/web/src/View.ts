// The app frame: the sidebar (projects, threads, search, shelves) and the routed page beside it, in
// t3code's sidebar wrapper. The hero page and a draft's page show the composer inside the hero;
// under an open thread it docks below the transcript. The judges' data attributes live in the
// sidebar's shell index. The sidebar, the composer and the chat header are lazy views over their own
// slices of the Model, so a streamed token rebuilds only the transcript and a keystroke only the
// composer. When the `ui` client setting is `next`, the `next` frame draws instead (ADR 0040).

import type { Entry } from "@cairn/protocol/Thread";
import { Equal, Option } from "effect";
import { createLazy } from "foldkit/html";
import type { Document, Html, HtmlBuilder } from "foldkit/html";

import { retryDraftId } from "./composer/Update.ts";
import * as Composer from "./composer/View.ts";
import { Message } from "./Message.ts";
import type { Model } from "./Model.ts";
import type { PageSlots } from "./next/Frame.ts";
import { nextFrameOf } from "./next/FrameLoad.ts";
import * as Thread from "./page/thread/index.ts";
import { view as pushView } from "./push/View.ts";
import { AppRoute, draftRouter } from "./Route.ts";
import { loadedSettingsView, settingsPlaceholder } from "./SettingsPage.ts";
import { view as parkedView } from "./shell/Parked.ts";
import { sidebarState, view as sidebarView } from "./sidebar/View.ts";
import { projectOf, threadRowOf } from "./ThreadRow.ts";
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

/**
 * Why the thread's launch failed, from its shell row, and the draft its first message went back to
 * when this page put it there.
 */
export const launchFailureOf = (
  model: Model,
  threadId: string
): Option.Option<Thread.LaunchFailure> =>
  Option.flatMap(
    Option.filter(
      threadRowOf(model.shell, threadId),
      (thread) => thread.activity === "failed"
    ),
    (thread) =>
      Option.map(thread.lastError, (message) => {
        const draftId = retryDraftId(threadId);

        return {
          message,
          retryUrl: Option.some(draftRouter({ draftId })).pipe(
            Option.filter(() =>
              Object.hasOwn(model.composer.drafts, `draft:${draftId}`)
            )
          ),
        };
      })
  );

const sidebarLazy = createLazy();

const headerLazy = createLazy();

// One slot per place the composer is drawn: a cached view belongs to one position in the tree.
const pageComposerLazy = createLazy();

const dockedComposerLazy = createLazy();

const threadPageLazy = createLazy();

/**
 * The thread page. Its inputs arrive as plain strings ("" for none) so the lazy view compares them
 * by value: the Options built from the shell are new on every render, and a keystroke in the
 * composer would otherwise redraw the whole transcript.
 */
const threadPage = (
  h: HtmlBuilder<Message>,
  thread: Model["thread"],
  workspaceRoot: string,
  failureMessage: string,
  retryUrl: string
): Html =>
  h.submodel({
    slotId: "thread",
    model: thread,
    view: Thread.view,
    viewInputs: {
      workspaceRoot:
        workspaceRoot === "" ? Option.none() : Option.some(workspaceRoot),
      launchFailure:
        failureMessage === ""
          ? Option.none()
          : Option.some({
              message: failureMessage,
              retryUrl: retryUrl === "" ? Option.none() : Option.some(retryUrl),
            }),
    },
    toParentMessage: (message) => Message.GotThreadMessage({ message }),
  });

const sidebar = (
  h: HtmlBuilder<Message>,
  sidebarModel: Model["sidebar"]
): Html =>
  h.submodel({
    slotId: "sidebar",
    model: sidebarModel,
    view: sidebarView,
    toParentMessage: (message) => Message.GotSidebarMessage({ message }),
  });

const composerView = (
  h: HtmlBuilder<Message>,
  composerModel: Model["composer"]
): Html =>
  h.submodel({
    slotId: "composer",
    model: composerModel,
    view: Composer.view,
    toParentMessage: (message) => Message.GotComposerMessage({ message }),
  });

const NO_ENTRIES: ReadonlyArray<Entry> = [];

/** The last thread page Model the header's controls were drawn from. */
const headerThread = new Map<"last", Thread.Model.Model>();

const olderOf = (thread: Thread.Model.Model): ReadonlyArray<Entry> =>
  Option.match(thread.view, {
    onNone: () => NO_ENTRIES,
    onSome: (state) => state.older,
  });

const windowOf = (thread: Thread.Model.Model): ReadonlyArray<Entry> =>
  Option.match(thread.view, {
    onNone: () => NO_ENTRIES,
    onSome: (state) => state.view.entries,
  });

/**
 * The thread page Model for the header's controls: the one they were last drawn from while the
 * fields `Thread.headerControls` reads (the diff, the thread id, the older and window entries) are
 * unchanged, so the header keeps its lazy view while the answer streams.
 */
const headerThreadOf = (thread: Thread.Model.Model): Thread.Model.Model => {
  const last = headerThread.get("last");

  if (
    last !== undefined &&
    last.diff === thread.diff &&
    Equal.equals(last.threadId, thread.threadId) &&
    olderOf(last) === olderOf(thread) &&
    windowOf(last) === windowOf(thread)
  ) {
    return last;
  }

  headerThread.set("last", thread);

  return thread;
};

/** The chat header over a thread: its project crumb (none when empty), its title and controls. */
const threadHeader = (
  h: HtmlBuilder<Message>,
  projectTitle: string,
  title: string,
  thread: Thread.Model.Model
): Html =>
  chatHeader(h, {
    project:
      projectTitle === ""
        ? Option.none()
        : Option.some({
            title: projectTitle,
            ariaLabel: `New thread in ${projectTitle}`,
            onClick: Option.none(),
          }),
    title,
    controls: [
      h.submodel({
        slotId: "thread-header-controls",
        model: thread,
        view: Thread.headerControls,
        toParentMessage: (message) => Message.GotThreadMessage({ message }),
      }),
    ],
  });

/** What the `next` frame draws inside a classic page; nothing in the classic views. */
const classicSlots = (h: HtmlBuilder<Message>): PageSlots => ({
  roleTable: () => h.empty,
});

const page = (model: Model, h: HtmlBuilder<Message>, slots: PageSlots): Html =>
  AppRoute.match(model.route, {
    Hero: () => pageComposerLazy(composerView, [h, model.composer]),
    Thread: ({ threadId }) => {
      const failure = launchFailureOf(model, threadId);
      const row = threadRowOf(model.shell, threadId);

      const project = Option.flatMap(row, (thread) =>
        projectOf(model.shell, thread)
      );

      // The thread's working directory: its worktree, else its project's workspace root.
      const workspaceRoot = Option.orElse(
        Option.flatMap(row, (thread) => thread.worktreePath),
        () => Option.map(project, ({ workspaceRoot: root }) => root)
      );

      return h.div(
        [
          h.DataAttribute("chat-column-maximized-away", "false"),
          h.DataAttribute("chat-column", "true"),
          h.Class(`relative ${CHAT_COLUMN_CLASS}`),
        ],
        [
          headerLazy(threadHeader, [
            h,
            Option.getOrElse(
              Option.map(project, ({ title }) => title),
              () => ""
            ),
            Option.getOrElse(
              Option.map(row, ({ title }) => title),
              () => "Thread"
            ),
            headerThreadOf(model.thread),
          ]),
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
              threadPageLazy(threadPage, [
                h,
                model.thread,
                Option.getOrElse(workspaceRoot, () => ""),
                Option.match(failure, {
                  onNone: () => "",
                  onSome: ({ message }) => message,
                }),
                Option.getOrElse(
                  Option.flatMap(failure, ({ retryUrl }) => retryUrl),
                  () => ""
                ),
              ]),
            ]
          ),
          dockedComposerLazy(composerView, [h, model.composer]),
        ]
      );
    },
    Draft: () => pageComposerLazy(composerView, [h, model.composer]),
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
              roleTable: slots.roleTable,
            },
            toParentMessage: (message) =>
              Message.GotSettingsMessage({ message }),
          }),
      }),
    // Only the `next` views draw the usage page; classic shows what it showed before the route.
    Usage: () => placeholder(h, "Nothing lives at /usage."),
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
          h.Class("flex items-start gap-2 border-b px-4 py-2 text-sm"),
        ],
        [
          h.span([h.Class("min-w-0 flex-1")], [notice]),
          h.button(
            [
              h.Type("button"),
              h.AriaLabel("Dismiss"),
              h.Class("shrink-0 underline-offset-4 hover:underline"),
              h.OnClick(Message.DismissedNotice()),
            ],
            ["Dismiss"]
          ),
        ]
      ),
  });

/** The app drawn with the classic views. */
const classicView = (model: Model, h: HtmlBuilder<Message>): Document => ({
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
      // `sidebarState` above reads only `model.sidebar`, the lazy view's one input.
      sidebarLazy(sidebar, [h, model.sidebar]),
      h.main(
        [
          h.DataAttribute("slot", "sidebar-inset"),
          h.Class(
            "relative flex min-w-0 w-full flex-1 flex-col bg-background text-foreground surface-grain h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
          ),
        ],
        [noticeBar(model, h), page(model, h, classicSlots(h))]
      ),
    ]
  ),
});

/**
 * The app: the `next` frame (`next/Frame.ts`, ADR 0040) when the `ui` setting is `next` and its
 * chunk has loaded, drawing the classic regions until `next` replaces them; the classic views
 * otherwise.
 */
export const view = (model: Model, h: HtmlBuilder<Message>): Document =>
  Option.match(nextFrameOf(model), {
    onNone: () => classicView(model, h),
    onSome: (frame) =>
      frame(model, h, {
        sidebarState: sidebarState(model.sidebar),
        sidebar: () => sidebarLazy(sidebar, [h, model.sidebar]),
        notice: () => noticeBar(model, h),
        page: (slots) => page(model, h, slots),
      }),
  });
